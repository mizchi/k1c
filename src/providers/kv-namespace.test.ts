import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { kvNamespaceProvider } from './kv-namespace.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = { kv: { namespaces: mock } } as unknown as Cloudflare;
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
    update: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  };
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

describe('kvNamespaceProvider', () => {
  describe('list', () => {
    it('yields only namespaces with k1c/ title prefix', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([
          { id: 'id-1', title: 'k1c/default/cache' },
          { id: 'id-2', title: 'k1c/prod/sessions' },
          { id: 'id-3', title: 'unmanaged' },
        ]),
      );
      const result = await collect(kvNamespaceProvider.list(buildCtx(mock)));
      expect(result.map((r) => r.label)).toEqual(['default/cache', 'prod/sessions']);
      expect(result.map((r) => r.nativeId)).toEqual(['id-1', 'id-2']);
      expect(mock.list).toHaveBeenCalledWith({ account_id: 'acc-123' });
    });

    it('skips namespaces with malformed titles', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([
          { id: 'id-1', title: 'k1c/' },
          { id: 'id-2', title: 'k1c/just-namespace' },
        ]),
      );
      const result = await collect(kvNamespaceProvider.list(buildCtx(mock)));
      expect(result).toHaveLength(0);
    });
  });

  describe('read', () => {
    it('returns properties for an existing namespace', async () => {
      const mock = buildMock();
      mock.get.mockResolvedValueOnce({ id: 'id-1', title: 'k1c/default/cache' });
      const props = await kvNamespaceProvider.read(buildCtx(mock), 'id-1');
      expect(props).toEqual({ title: 'k1c/default/cache' });
      expect(mock.get).toHaveBeenCalledWith('id-1', { account_id: 'acc-123' });
    });

    it('returns NotFound on 404', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
      const props = await kvNamespaceProvider.read(buildCtx(mock), 'id-1');
      expect(props).toBe(NotFound);
    });
  });

  describe('create', () => {
    it('calls SDK with title and returns nativeId from response', async () => {
      const mock = buildMock();
      mock.create.mockResolvedValueOnce({ id: 'id-new', title: 'k1c/default/cache' });
      const result = await kvNamespaceProvider.create(buildCtx(mock), 'default/cache', {
        title: 'k1c/default/cache',
      });
      expect(result).toEqual({
        kind: 'sync',
        nativeId: 'id-new',
        properties: { title: 'k1c/default/cache' },
      });
      expect(mock.create).toHaveBeenCalledWith({
        account_id: 'acc-123',
        title: 'k1c/default/cache',
      });
    });
  });

  describe('update', () => {
    it('updates the title via SDK', async () => {
      const mock = buildMock();
      mock.update.mockResolvedValueOnce({ id: 'id-1', title: 'k1c/default/new-cache' });
      const result = await kvNamespaceProvider.update(
        buildCtx(mock),
        'id-1',
        { title: 'k1c/default/cache' },
        { title: 'k1c/default/new-cache' },
      );
      expect(result).toMatchObject({
        kind: 'sync',
        nativeId: 'id-1',
      });
      expect(mock.update).toHaveBeenCalledWith('id-1', {
        account_id: 'acc-123',
        title: 'k1c/default/new-cache',
      });
    });

    it('returns noop when title is unchanged', async () => {
      const mock = buildMock();
      const result = await kvNamespaceProvider.update(
        buildCtx(mock),
        'id-1',
        { title: 'k1c/default/cache' },
        { title: 'k1c/default/cache' },
      );
      expect(result).toEqual({ kind: 'noop' });
      expect(mock.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('calls SDK with namespace id', async () => {
      const mock = buildMock();
      mock.delete.mockResolvedValueOnce(undefined);
      const result = await kvNamespaceProvider.delete(buildCtx(mock), 'id-1');
      expect(result).toEqual({ kind: 'sync' });
      expect(mock.delete).toHaveBeenCalledWith('id-1', { account_id: 'acc-123' });
    });
  });
});
