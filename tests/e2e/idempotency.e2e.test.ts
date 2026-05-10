import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/providers/index.ts';
import type { CloudflareResourceProvider } from '../../src/providers/types.ts';
import { buildE2EContext, e2eEnabled, RUN_ID, safeCleanup } from './_harness.ts';

/**
 * Provider-by-provider idempotency check against a real Cloudflare
 * account. For each provider with a small disposable spec we:
 *
 *   1. provider.create(label, desired)
 *   2. provider.list() — assert the just-created resource is yielded
 *   3. provider.read(nativeId) — round-trip the props
 *   4. provider.equals(read, desired) — assert true (or default
 *      stable-key JSON compare when the provider doesn't override
 *      equals)
 *   5. provider.delete(nativeId)
 *
 * The assertion that catches the "drift" class of bugs is step 4:
 * Cloudflare endpoints often return defaults the manifest didn't set
 * (R2 storage_class=Standard, Vectorize description="", DNS
 * proxied=false, AccessApplication auto_redirect_to_identity=false,
 * ...) — without normalizing, every re-apply / second reconcile flags
 * those as drifting and tries an UPDATE that may fail (R2 immutable)
 * or just produce noise.
 *
 * Each row is tagged with `requires: 'zone'` when it needs a live
 * `K1C_ZONE_ID`. Tests are sequential (vitest.e2e.config.ts pins
 * `concurrent: false`) so cleanup races don't surface.
 */

const RUN_E2E = e2eEnabled();
const HAS_ZONE = !!process.env['K1C_ZONE_ID'];

const ctx = (() => {
  if (!RUN_E2E) return null;
  return buildE2EContext().providerCtx;
})();
const registry = RUN_E2E ? createDefaultRegistry() : null;
const RUN = RUN_ID;

interface Row {
  readonly name: string;
  readonly requiresZone?: boolean;
  readonly props: () => Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

const rows: Row[] = [
  { name: 'R2Bucket', props: () => ({ bucketName: `k1c-default-r2-${RUN}`, location: 'weur' }) },
  { name: 'KVNamespace', props: () => ({ title: `k1c/default/kv-${RUN}` }) },
  { name: 'D1Database', props: () => ({ databaseName: `k1c-default-d1-${RUN}` }) },
  { name: 'Queue', props: () => ({ queueName: `k1c-default-q-${RUN}` }) },
  {
    name: 'Vectorize',
    props: () => ({
      indexName: `k1c-default-vec-${RUN}`,
      dimensions: 768,
      metric: 'cosine',
    }),
  },
  {
    name: 'DNSRecord',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      type: 'TXT',
      name: `k1c-debug-${RUN}.mizchi.net`,
      content: '"k1c idempotency"',
      ttl: 300,
    }),
  },
  {
    name: 'WAFCustomRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path contains "/k1c-debug-no-such-path")',
      action: 'block',
      enabled: false,
    }),
  },
  {
    name: 'RateLimitRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path contains "/k1c-debug-no-such-path")',
      action: 'block',
      enabled: false,
      ratelimit: {
        characteristics: ['ip.src', 'cf.colo.id'],
        period: 10,
        requestsPerPeriod: 100,
        mitigationTimeout: 10,
      },
    }),
  },
  {
    name: 'TransformRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path contains "/k1c-debug-no-such-path")',
      enabled: false,
      headers: { 'x-k1c-debug': { operation: 'set', value: 'on' } },
    }),
  },
  {
    name: 'URIRewriteRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path eq "/k1c-debug-rewrite")',
      enabled: false,
      path: { value: '/rewritten' },
    }),
  },
  {
    name: 'ResponseHeaderRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path contains "/k1c-debug-no-such-path")',
      enabled: false,
      headers: { 'x-k1c-debug': { operation: 'set', value: 'on' } },
    }),
  },
  {
    name: 'CacheRule',
    requiresZone: true,
    props: () => ({
      zoneId: process.env['K1C_ZONE_ID']!,
      expression: '(http.request.uri.path contains "/k1c-debug-no-such-path")',
      cache: false,
      enabled: false,
    }),
  },
];

describe.skipIf(!RUN_E2E)('e2e: idempotency across providers', () => {
  for (const row of rows) {
    const skipForZone = row.requiresZone && !HAS_ZONE;
    it.skipIf(skipForZone)(`${row.name} round-trips through create→read→equals`, async () => {
      const provider = registry!.get(row.name) as CloudflareResourceProvider<unknown>;
      const label = `default/${row.name.toLowerCase()}-${RUN}`;
      const desired = row.props();

      let nativeId: string | undefined;
      try {
        const created = await provider.create(ctx!, label, desired);
        expect(created.kind).toBe('sync');
        nativeId = (created as { nativeId: string }).nativeId;

        let listed = false;
        for await (const item of provider.list(ctx!)) {
          if (item.nativeId === nativeId) {
            listed = true;
            break;
          }
        }
        expect(listed, `${row.name} should appear in list()`).toBe(true);

        const read = await provider.read(ctx!, nativeId);
        expect(read).not.toBe('NotFound');

        const equal = provider.equals
          ? provider.equals(read, desired)
          : stableStringify(read) === stableStringify(desired);
        expect(
          equal,
          `${row.name} drift:\n  read=${stableStringify(read)}\n  want=${stableStringify(desired)}`,
        ).toBe(true);
      } finally {
        if (nativeId !== undefined) {
          await safeCleanup(() => provider.delete(ctx!, nativeId!));
        }
      }
    });
  }
});
