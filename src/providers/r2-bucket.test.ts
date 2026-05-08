import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { r2BucketProvider } from './r2-bucket.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = {
    r2: { buckets: mock },
  } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

function buildMock(): MockCalls {
  return {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('r2BucketProvider', () => {
  describe('list', () => {
    it('yields only buckets matching the k1c- prefix', async () => {
      const mock = buildMock();
      mock.list.mockResolvedValueOnce({
        buckets: [
          { name: 'k1c-default-media', creation_date: '2026-01-01' },
          { name: 'k1c-prod-uploads', creation_date: '2026-01-02' },
          { name: 'unmanaged-bucket', creation_date: '2026-01-03' },
        ],
      });
      const ctx = buildCtx(mock);
      const result = await collect(r2BucketProvider.list(ctx));
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.label)).toEqual(['default/media', 'prod/uploads']);
      expect(result.map((r) => r.nativeId)).toEqual(['k1c-default-media', 'k1c-prod-uploads']);
      expect(mock.list).toHaveBeenCalledWith({ account_id: 'acc-123' });
    });

    it('handles empty bucket list', async () => {
      const mock = buildMock();
      mock.list.mockResolvedValueOnce({ buckets: [] });
      const result = await collect(r2BucketProvider.list(buildCtx(mock)));
      expect(result).toHaveLength(0);
    });

    it('skips entries without parsable label (no namespace separator)', async () => {
      const mock = buildMock();
      mock.list.mockResolvedValueOnce({
        buckets: [{ name: 'k1c-noseparator' }, { name: 'k1c-' }],
      });
      const result = await collect(r2BucketProvider.list(buildCtx(mock)));
      expect(result).toHaveLength(0);
    });

    it('treats name segments after first dash as part of resource name', async () => {
      const mock = buildMock();
      mock.list.mockResolvedValueOnce({
        buckets: [{ name: 'k1c-prod-multi-word-name' }],
      });
      const result = await collect(r2BucketProvider.list(buildCtx(mock)));
      expect(result[0]?.label).toBe('prod/multi-word-name');
    });
  });

  describe('read', () => {
    it('returns properties for an existing bucket', async () => {
      const mock = buildMock();
      mock.get.mockResolvedValueOnce({
        name: 'k1c-default-media',
        location: 'weur',
        storage_class: 'Standard',
      });
      const props = await r2BucketProvider.read(buildCtx(mock), 'k1c-default-media');
      expect(props).toEqual({
        bucketName: 'k1c-default-media',
        location: 'weur',
        storageClass: 'Standard',
      });
      expect(mock.get).toHaveBeenCalledWith('k1c-default-media', { account_id: 'acc-123' });
    });

    it('returns NotFound on 404', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 404, message: 'not found' });
      const props = await r2BucketProvider.read(buildCtx(mock), 'k1c-default-media');
      expect(props).toBe(NotFound);
    });

    it('rethrows non-404 API errors as ProviderError', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 403, message: 'forbidden' });
      await expect(r2BucketProvider.read(buildCtx(mock), 'k1c-default-media')).rejects.toMatchObject({
        code: 'AccessDenied',
        recoverable: false,
      });
    });
  });

  describe('create', () => {
    it('calls SDK with name + location + storageClass', async () => {
      const mock = buildMock();
      mock.create.mockResolvedValueOnce({ name: 'k1c-default-media', location: 'weur' });
      const result = await r2BucketProvider.create(buildCtx(mock), 'default/media', {
        bucketName: 'k1c-default-media',
        location: 'weur',
        storageClass: 'Standard',
      });
      expect(result).toEqual({
        kind: 'sync',
        nativeId: 'k1c-default-media',
        properties: expect.objectContaining({ bucketName: 'k1c-default-media' }),
      });
      expect(mock.create).toHaveBeenCalledWith({
        account_id: 'acc-123',
        name: 'k1c-default-media',
        locationHint: 'weur',
        storageClass: 'Standard',
      });
    });

    it('omits optional fields when not provided', async () => {
      const mock = buildMock();
      mock.create.mockResolvedValueOnce({ name: 'k1c-default-x' });
      await r2BucketProvider.create(buildCtx(mock), 'default/x', {
        bucketName: 'k1c-default-x',
      });
      expect(mock.create).toHaveBeenCalledWith({
        account_id: 'acc-123',
        name: 'k1c-default-x',
      });
    });

    it('translates 409 AlreadyExists to ProviderError', async () => {
      const mock = buildMock();
      mock.create.mockRejectedValueOnce({ status: 409, message: 'exists' });
      await expect(
        r2BucketProvider.create(buildCtx(mock), 'default/x', { bucketName: 'k1c-default-x' }),
      ).rejects.toMatchObject({ code: 'AlreadyExists' });
    });
  });

  describe('update', () => {
    it('returns NotUpdatable when location changes (R2 location is immutable)', async () => {
      const mock = buildMock();
      const ctx = buildCtx(mock);
      await expect(
        r2BucketProvider.update(
          ctx,
          'k1c-default-x',
          { bucketName: 'k1c-default-x', location: 'weur' },
          { bucketName: 'k1c-default-x', location: 'enam' },
        ),
      ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
    });

    it('returns noop when properties are identical', async () => {
      const mock = buildMock();
      const ctx = buildCtx(mock);
      const props = { bucketName: 'k1c-default-x', location: 'weur' as const };
      const result = await r2BucketProvider.update(ctx, 'k1c-default-x', props, props);
      expect(result).toEqual({ kind: 'noop' });
    });
  });

  describe('delete', () => {
    it('calls SDK with bucket name', async () => {
      const mock = buildMock();
      mock.delete.mockResolvedValueOnce(undefined);
      const result = await r2BucketProvider.delete(buildCtx(mock), 'k1c-default-x');
      expect(result).toEqual({ kind: 'sync' });
      expect(mock.delete).toHaveBeenCalledWith('k1c-default-x', { account_id: 'acc-123' });
    });

    it('translates 404 NotFound to ProviderError', async () => {
      const mock = buildMock();
      mock.delete.mockRejectedValueOnce({ status: 404, message: 'gone' });
      await expect(r2BucketProvider.delete(buildCtx(mock), 'missing')).rejects.toMatchObject({
        code: 'NotFound',
      });
    });
  });
});
