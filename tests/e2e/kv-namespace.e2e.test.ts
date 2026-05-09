import { describe, it, expect } from 'vitest';
import { kvNamespaceProvider } from '../../src/providers/kv-namespace.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled();

describe.skipIf(!RUN_E2E)('e2e: KVNamespace provider', () => {
  it('creates, lists, reads, and deletes a namespace against a real account', async () => {
    const { providerCtx } = buildE2EContext();
    const title = `k1c/default/${e2eName('kv')}`;
    const label = `default/${e2eName('kv')}`;

    let nativeId: string | undefined;
    try {
      const created = await kvNamespaceProvider.create(providerCtx, label, { title });
      expect(created.kind).toBe('sync');
      nativeId = created.nativeId;

      const listed: Array<{ nativeId: string; label: string }> = [];
      for await (const item of kvNamespaceProvider.list(providerCtx)) {
        listed.push(item);
      }
      expect(listed.find((x) => x.nativeId === nativeId)).toBeDefined();

      const read = await kvNamespaceProvider.read(providerCtx, nativeId);
      expect(read).not.toBe('NotFound' as never);
    } finally {
      if (nativeId !== undefined) {
        await safeCleanup(() => kvNamespaceProvider.delete(providerCtx, nativeId!));
      }
    }
  });
});
