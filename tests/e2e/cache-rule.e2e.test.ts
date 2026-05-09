import { describe, it, expect } from 'vitest';
import { cacheRuleProvider } from '../../src/providers/cache-rule.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled() && Boolean(process.env['K1C_ZONE_ID']);

describe.skipIf(!RUN_E2E)('e2e: CacheRule provider', () => {
  it('creates, lists, reads, and deletes a cache rule against a real zone', async () => {
    const { providerCtx } = buildE2EContext();
    const ruleLabel = `default/${e2eName('cache')}`;

    let nativeId: string | undefined;
    try {
      const created = await cacheRuleProvider.create(providerCtx, ruleLabel, {
        zoneId: providerCtx.zoneId!,
        expression: '(http.request.uri.path contains "/k1c-e2e-test/")',
        cache: true,
        enabled: true,
        edgeTtl: { mode: 'override_origin', default: 60 },
      });
      expect(created.kind).toBe('sync');
      nativeId = created.nativeId;

      // List should surface the just-created rule.
      const seen: Array<{ nativeId: string; label: string }> = [];
      for await (const item of cacheRuleProvider.list(providerCtx)) {
        seen.push(item);
      }
      expect(seen.find((x) => x.nativeId === nativeId)).toBeDefined();

      const read = await cacheRuleProvider.read(providerCtx, nativeId);
      expect(read).not.toBe('NotFound' as never);
    } finally {
      if (nativeId !== undefined) {
        await safeCleanup(() => cacheRuleProvider.delete(providerCtx, nativeId!));
      }
    }
  });
});
