import { describe, it, expect } from 'vitest';
import { accessPolicyProvider } from '../../src/providers/access-policy.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled();

describe.skipIf(!RUN_E2E)('e2e: AccessPolicy provider', () => {
  it('creates, lists, reads, and deletes a reusable Access policy', async () => {
    const { providerCtx } = buildE2EContext();
    const policyName = e2eName('k1c-policy');
    const label = `default/${policyName}`;

    let nativeId: string | undefined;
    try {
      const created = await accessPolicyProvider.create(providerCtx, label, {
        policyName,
        decision: 'allow',
        include: [{ everyone: {} }],
      });
      expect(created.kind).toBe('sync');
      nativeId = created.nativeId;

      const seen: Array<{ nativeId: string; label: string }> = [];
      for await (const item of accessPolicyProvider.list(providerCtx)) {
        seen.push(item);
      }
      expect(seen.find((x) => x.nativeId === nativeId)).toBeDefined();

      const read = await accessPolicyProvider.read(providerCtx, nativeId);
      expect(read).not.toBe('NotFound' as never);
    } finally {
      if (nativeId !== undefined) {
        await safeCleanup(() => accessPolicyProvider.delete(providerCtx, nativeId!));
      }
    }
  });
});
