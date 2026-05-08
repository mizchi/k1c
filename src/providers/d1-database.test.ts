import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { d1DatabaseProvider } from './d1-database.ts';
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
  const cf = { d1: { database: mock } } as unknown as Cloudflare;
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
  update: vi.fn(),
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

describe('d1DatabaseProvider', () => {
  it('list yields only databases with k1c- prefix', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { uuid: 'd1', name: 'k1c-default-app-db' },
        { uuid: 'd2', name: 'unmanaged-db' },
      ]),
    );
    const result = await collect(d1DatabaseProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'd1', label: 'default/app-db' }]);
  });

  it('read returns properties for an existing database', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({ uuid: 'd1', name: 'k1c-default-app-db' });
    const props = await d1DatabaseProvider.read(buildCtx(mock), 'd1');
    expect(props).toEqual({ databaseName: 'k1c-default-app-db' });
  });

  it('read returns NotFound on 404', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
    expect(await d1DatabaseProvider.read(buildCtx(mock), 'd1')).toBe(NotFound);
  });

  it('create calls SDK with name + primary_location_hint', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ uuid: 'd-new' });
    await d1DatabaseProvider.create(buildCtx(mock), 'default/app-db', {
      databaseName: 'k1c-default-app-db',
      primaryLocationHint: 'weur',
    });
    expect(mock.create).toHaveBeenCalledWith({
      account_id: 'acc-123',
      name: 'k1c-default-app-db',
      primary_location_hint: 'weur',
    });
  });

  it('update with same properties is a noop', async () => {
    const mock = buildMock();
    const props = { databaseName: 'k1c-default-app-db' };
    const result = await d1DatabaseProvider.update(buildCtx(mock), 'd1', props, props);
    expect(result).toEqual({ kind: 'noop' });
  });

  it('update with changed name throws NotUpdatable', async () => {
    const mock = buildMock();
    await expect(
      d1DatabaseProvider.update(
        buildCtx(mock),
        'd1',
        { databaseName: 'k1c-default-old' },
        { databaseName: 'k1c-default-new' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('delete calls SDK with database id', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await d1DatabaseProvider.delete(buildCtx(mock), 'd1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('d1', { account_id: 'acc-123' });
  });
});
