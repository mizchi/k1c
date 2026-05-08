import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { vectorizeProvider } from './vectorize.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = { vectorize: { indexes: mock } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): MockCalls => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
});

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

describe('vectorizeProvider', () => {
  it('list yields only indexes with k1c- prefix', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { name: 'k1c-default-docs', config: { dimensions: 768, metric: 'cosine' } },
        { name: 'unmanaged-index', config: { dimensions: 768, metric: 'cosine' } },
      ]),
    );
    const result = await collect(vectorizeProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'k1c-default-docs', label: 'default/docs' }]);
  });

  it('read returns properties for an existing index', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      name: 'k1c-default-docs',
      config: { dimensions: 768, metric: 'cosine' },
    });
    const props = await vectorizeProvider.read(buildCtx(mock), 'k1c-default-docs');
    expect(props).toEqual({
      indexName: 'k1c-default-docs',
      dimensions: 768,
      metric: 'cosine',
    });
  });

  it('read returns NotFound on 404', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
    expect(await vectorizeProvider.read(buildCtx(mock), 'k1c-default-docs')).toBe(NotFound);
  });

  it('create calls SDK with name + config', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ name: 'k1c-default-docs' });
    await vectorizeProvider.create(buildCtx(mock), 'default/docs', {
      indexName: 'k1c-default-docs',
      dimensions: 768,
      metric: 'cosine',
    });
    expect(mock.create).toHaveBeenCalledWith({
      account_id: 'acc-123',
      name: 'k1c-default-docs',
      config: { dimensions: 768, metric: 'cosine' },
    });
  });

  it('update with changed dimensions throws NotUpdatable', async () => {
    const mock = buildMock();
    await expect(
      vectorizeProvider.update(
        buildCtx(mock),
        'k1c-default-docs',
        { indexName: 'k1c-default-docs', dimensions: 768, metric: 'cosine' },
        { indexName: 'k1c-default-docs', dimensions: 1536, metric: 'cosine' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('delete calls SDK with index name', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await vectorizeProvider.delete(buildCtx(mock), 'k1c-default-docs');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('k1c-default-docs', { account_id: 'acc-123' });
  });
});
