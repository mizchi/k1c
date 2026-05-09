import { describe, it, expect } from 'vitest';
import { r2BucketProvider } from '../../src/providers/r2-bucket.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled();

describe.skipIf(!RUN_E2E)('e2e: R2Bucket provider', () => {
  it('creates, lists, reads, and deletes a bucket against a real account', async () => {
    const { providerCtx } = buildE2EContext();
    const bucketName = e2eName('k1c-r2');
    const label = `default/${bucketName}`;

    let nativeId: string | undefined;
    try {
      const created = await r2BucketProvider.create(providerCtx, label, {
        bucketName,
      });
      expect(created.kind).toBe('sync');
      nativeId = created.nativeId;

      // List should include the just-created bucket. R2 buckets have no
      // ownership marker, so the provider's list filter is by name.
      const listed: Array<{ nativeId: string; label: string }> = [];
      for await (const item of r2BucketProvider.list(providerCtx)) {
        listed.push(item);
      }
      expect(listed.find((x) => x.nativeId === nativeId)).toBeDefined();

      const read = await r2BucketProvider.read(providerCtx, nativeId);
      expect(read).not.toBe('NotFound' as never);
    } finally {
      if (nativeId !== undefined) {
        await safeCleanup(() => r2BucketProvider.delete(providerCtx, nativeId!));
      }
    }
  });
});
