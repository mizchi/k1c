import { describe, it, expect } from 'vitest';
import { generateTelemetryAggregator } from './aggregator-template.ts';

describe('generateTelemetryAggregator', () => {
  it('emits a Worker module with the verify flag baked in', () => {
    const src = generateTelemetryAggregator({ verifyHmac: true });
    expect(src).toContain('VERIFY_HMAC = true');
    expect(src).toContain('export default {');
  });

  it('verifyHmac=false bypasses signature checking', async () => {
    const src = generateTelemetryAggregator({ verifyHmac: false });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
    const mod = (await import(dataUrl)) as {
      default: {
        fetch: (
          req: Request,
          env: Record<string, unknown>,
          ctx: { waitUntil: (p: Promise<unknown>) => void },
        ) => Promise<Response>;
      };
    };
    const ndjson = '{"a":1}\n{"a":2}\n';
    const res = await mod.default.fetch(
      new Request('https://x.example/logpush', { method: 'POST', body: ndjson }),
      {},
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { forwarded: number };
    expect(j.forwarded).toBe(2);
  });

  it('rejects unauthenticated requests when verifyHmac=true and a signature header is missing', async () => {
    const src = generateTelemetryAggregator({ verifyHmac: true });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
    const mod = (await import(dataUrl)) as {
      default: {
        fetch: (
          req: Request,
          env: Record<string, unknown>,
          ctx: { waitUntil: (p: Promise<unknown>) => void },
        ) => Promise<Response>;
      };
    };
    const res = await mod.default.fetch(
      new Request('https://x.example/logpush', { method: 'POST', body: '{"a":1}' }),
      { LOGPUSH_HMAC: 'shhh' },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
  });
});
