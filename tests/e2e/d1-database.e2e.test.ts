import { describe, it, expect } from 'vitest';
import { d1DatabaseProvider } from '../../src/providers/d1-database.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled();

describe.skipIf(!RUN_E2E)('e2e: D1Database provider', () => {
  it('creates, lists, reads, and deletes a database against a real account', async () => {
    const { providerCtx } = buildE2EContext();
    const databaseName = e2eName('k1c-d1');
    const label = `default/${databaseName}`;

    let nativeId: string | undefined;
    try {
      const created = await d1DatabaseProvider.create(providerCtx, label, { databaseName });
      expect(created.kind).toBe('sync');
      nativeId = created.nativeId;

      const listed: Array<{ nativeId: string; label: string }> = [];
      for await (const item of d1DatabaseProvider.list(providerCtx)) {
        listed.push(item);
      }
      expect(listed.find((x) => x.nativeId === nativeId)).toBeDefined();

      const read = await d1DatabaseProvider.read(providerCtx, nativeId);
      expect(read).not.toBe('NotFound' as never);
    } finally {
      if (nativeId !== undefined) {
        await safeCleanup(() => d1DatabaseProvider.delete(providerCtx, nativeId!));
      }
    }
  });
});
