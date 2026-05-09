/**
 * Generates the JavaScript source for a k1c telemetry aggregator Worker.
 *
 * The aggregator is the receiving end of a Cloudflare Logpush HTTP
 * destination. Logpush POSTs newline-delimited JSON batches to its URL;
 * this Worker:
 *
 *   1. Verifies the request via a shared HMAC secret in `env.LOGPUSH_HMAC`
 *      (compared to the `X-Cloudflare-LogPush-Signature` header). When the
 *      secret is absent the verifier no-ops, so the same script works in
 *      `--dry-run` and local-dev modes.
 *   2. For each NDJSON line, fans out to whichever forwarders are bound:
 *      - `env.QUEUE`     → `send({ event })` to a Cloudflare Queue
 *      - `env.SINK_R2`   → `put(<random>, line)` to R2 (cold storage)
 *      - `env.OTLP_URL`  + `env.OTLP_HEADERS` → POST to an OTLP collector
 *
 *   The forwarders are all optional — a manifest binds whichever subset of
 *   them it wants. Missing bindings short-circuit silently.
 */

export interface AggregatorTemplateOptions {
  /**
   * Whether the request signature is checked. Set to `false` (default in
   * test only) to skip verification; production should always be `true`.
   */
  readonly verifyHmac?: boolean;
}

export function generateTelemetryAggregator(opts: AggregatorTemplateOptions = {}): string {
  const verifyHmac = opts.verifyHmac ?? true;
  return `// k1c telemetry aggregator (generated)
// verifyHmac=${verifyHmac}

const VERIFY_HMAC = ${verifyHmac};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const verified = await verify(request, env);
    if (!verified) return new Response('unauthorized', { status: 401 });

    const body = await request.text();
    const lines = body.split('\\n').filter((s) => s.length > 0);

    let forwarded = 0;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (_e) {
        // Logpush is supposed to send valid JSON per line; malformed lines
        // are dropped rather than failing the whole batch.
        continue;
      }
      ctx.waitUntil(forward(event, line, env));
      forwarded += 1;
    }
    return Response.json({ ok: true, forwarded });
  },
};

async function verify(request, env) {
  if (!VERIFY_HMAC) return true;
  const secret = env.LOGPUSH_HMAC;
  if (!secret) return true;
  const sig = request.headers.get('x-cloudflare-logpush-signature');
  if (!sig) return false;
  const buf = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = hexToBytes(sig);
  return crypto.subtle.verify('HMAC', key, sigBytes, buf);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function forward(event, rawLine, env) {
  const promises = [];
  if (env.QUEUE) {
    promises.push(env.QUEUE.send({ event }));
  }
  if (env.SINK_R2) {
    const key = \`\${new Date().toISOString()}-\${crypto.randomUUID()}.json\`;
    promises.push(env.SINK_R2.put(key, rawLine));
  }
  if (env.OTLP_URL) {
    let extraHeaders = {};
    if (env.OTLP_HEADERS) {
      try {
        extraHeaders = JSON.parse(env.OTLP_HEADERS);
      } catch (_e) {}
    }
    promises.push(
      fetch(env.OTLP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extraHeaders },
        body: rawLine,
      }),
    );
  }
  await Promise.allSettled(promises);
}
`;
}
