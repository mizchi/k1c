import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { dispatchNamespaceProvider } from './dispatch-namespace.ts';
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
    workersForPlatforms: { dispatch: { namespaces: mock } },
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

describe('dispatchNamespaceProvider', () => {
  describe('list', () => {
    it('yields only namespaces with k1c- prefix and parses label from <k8s-ns>-<name>', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([
          { namespace_name: 'k1c-default-production', namespace_id: 'id-1' },
          { namespace_name: 'k1c-prod-platform', namespace_id: 'id-2' },
          { namespace_name: 'unmanaged-ns', namespace_id: 'id-3' },
        ]),
      );
      const result = await collect(dispatchNamespaceProvider.list(buildCtx(mock)));
      expect(result.map((r) => r.label)).toEqual(['default/production', 'prod/platform']);
      expect(result.map((r) => r.nativeId)).toEqual([
        'k1c-default-production',
        'k1c-prod-platform',
      ]);
    });

    it('skips unparsable names', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([{ namespace_name: 'k1c-' }, { namespace_name: 'k1c-noseparator' }]),
      );
      const result = await collect(dispatchNamespaceProvider.list(buildCtx(mock)));
      expect(result).toHaveLength(0);
    });
  });

  describe('read', () => {
    it('returns properties for an existing namespace', async () => {
      const mock = buildMock();
      mock.get.mockResolvedValueOnce({ namespace_name: 'k1c-default-production' });
      const props = await dispatchNamespaceProvider.read(
        buildCtx(mock),
        'k1c-default-production',
      );
      expect(props).toEqual({ namespaceName: 'k1c-default-production' });
      expect(mock.get).toHaveBeenCalledWith('k1c-default-production', {
        account_id: 'acc-123',
      });
    });

    it('returns NotFound on 404', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
      const props = await dispatchNamespaceProvider.read(buildCtx(mock), 'k1c-x-y');
      expect(props).toBe(NotFound);
    });
  });

  describe('create', () => {
    it('calls SDK with name and returns nativeId from response', async () => {
      const mock = buildMock();
      mock.create.mockResolvedValueOnce({ namespace_name: 'k1c-default-production' });
      const result = await dispatchNamespaceProvider.create(
        buildCtx(mock),
        'default/production',
        { namespaceName: 'k1c-default-production' },
      );
      expect(result).toMatchObject({
        kind: 'sync',
        nativeId: 'k1c-default-production',
      });
      expect(mock.create).toHaveBeenCalledWith({
        account_id: 'acc-123',
        name: 'k1c-default-production',
      });
    });

    it('translates 409 AlreadyExists from SDK', async () => {
      const mock = buildMock();
      mock.create.mockRejectedValueOnce({ status: 409, message: 'exists' });
      await expect(
        dispatchNamespaceProvider.create(buildCtx(mock), 'default/x', {
          namespaceName: 'k1c-default-x',
        }),
      ).rejects.toMatchObject({ code: 'AlreadyExists' });
    });
  });

  describe('update', () => {
    it('returns NotUpdatable when name changes (immutable)', async () => {
      const mock = buildMock();
      await expect(
        dispatchNamespaceProvider.update(
          buildCtx(mock),
          'k1c-default-x',
          { namespaceName: 'k1c-default-x' },
          { namespaceName: 'k1c-default-y' },
        ),
      ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
    });

    it('returns noop when name is unchanged', async () => {
      const mock = buildMock();
      const result = await dispatchNamespaceProvider.update(
        buildCtx(mock),
        'k1c-default-x',
        { namespaceName: 'k1c-default-x' },
        { namespaceName: 'k1c-default-x' },
      );
      expect(result).toEqual({ kind: 'noop' });
    });
  });

  describe('delete', () => {
    it('calls SDK with namespace name', async () => {
      const mock = buildMock();
      mock.delete.mockResolvedValueOnce(undefined);
      const result = await dispatchNamespaceProvider.delete(buildCtx(mock), 'k1c-default-x');
      expect(result).toEqual({ kind: 'sync' });
      expect(mock.delete).toHaveBeenCalledWith('k1c-default-x', {
        account_id: 'acc-123',
      });
    });
  });
});
