import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { customDomainProvider } from './custom-domain.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = { workers: { domains: mock } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

function buildMock(): MockCalls {
  return { update: vi.fn(), list: vi.fn(), get: vi.fn(), delete: vi.fn() };
}

function pageOf<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          i < items.length
            ? Promise.resolve({ value: items[i++]!, done: false as const })
            : Promise.resolve({ value: undefined as unknown as T, done: true as const }),
      };
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('customDomainProvider', () => {
  describe('list', () => {
    it('yields only domains pointing at k1c-managed services', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([
          { id: 'd1', hostname: 'api.example.com', service: 'k1c--default--api', zone_id: 'z1' },
          { id: 'd2', hostname: 'foo.example.com', service: 'unmanaged-worker', zone_id: 'z1' },
        ]),
      );
      const result = await collect(customDomainProvider.list(buildCtx(mock)));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ nativeId: 'd1', label: 'api.example.com' });
    });
  });

  describe('read', () => {
    it('returns properties for an existing domain', async () => {
      const mock = buildMock();
      mock.get.mockResolvedValueOnce({
        id: 'd1',
        hostname: 'api.example.com',
        service: 'k1c--default--api',
        zone_id: 'z1',
        environment: 'production',
      });
      const props = await customDomainProvider.read(buildCtx(mock), 'd1');
      expect(props).toEqual({
        hostname: 'api.example.com',
        service: 'k1c--default--api',
        zoneId: 'z1',
        environment: 'production',
      });
    });

    it('returns NotFound on 404', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
      const props = await customDomainProvider.read(buildCtx(mock), 'd1');
      expect(props).toBe(NotFound);
    });
  });

  describe('create', () => {
    it('upserts the domain via PUT-style update', async () => {
      const mock = buildMock();
      mock.update.mockResolvedValueOnce({ id: 'd-new' });
      const result = await customDomainProvider.create(buildCtx(mock), 'api.example.com', {
        hostname: 'api.example.com',
        service: 'k1c--default--api',
        zoneId: 'z1',
        environment: 'production',
      });
      expect(result).toMatchObject({ kind: 'sync', nativeId: 'd-new' });
      expect(mock.update).toHaveBeenCalledWith({
        account_id: 'acc-123',
        hostname: 'api.example.com',
        service: 'k1c--default--api',
        zone_id: 'z1',
        environment: 'production',
      });
    });
  });

  describe('update', () => {
    it('re-issues the upsert (no per-id update endpoint exists)', async () => {
      const mock = buildMock();
      mock.update.mockResolvedValueOnce({ id: 'd1' });
      await customDomainProvider.update(
        buildCtx(mock),
        'd1',
        {
          hostname: 'api.example.com',
          service: 'k1c--default--api',
          zoneId: 'z1',
          environment: 'production',
        },
        {
          hostname: 'api.example.com',
          service: 'k1c--default--api-v2',
          zoneId: 'z1',
          environment: 'production',
        },
      );
      expect(mock.update).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'k1c--default--api-v2' }),
      );
    });
  });

  describe('delete', () => {
    it('calls SDK delete with the domain id', async () => {
      const mock = buildMock();
      mock.delete.mockResolvedValueOnce(undefined);
      const result = await customDomainProvider.delete(buildCtx(mock), 'd1');
      expect(result).toEqual({ kind: 'sync' });
      expect(mock.delete).toHaveBeenCalledWith('d1', { account_id: 'acc-123' });
    });
  });
});
