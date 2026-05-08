import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { hyperdriveProvider } from './hyperdrive.ts';
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
  const cf = { hyperdrive: { configs: mock } } as unknown as Cloudflare;
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

const desiredProps = {
  name: 'k1c-default-app-db',
  origin: {
    scheme: 'postgres' as const,
    host: 'db.internal',
    port: 5432,
    database: 'app',
    user: 'app',
    password: 'hunter2',
  },
  caching: { disabled: false, maxAge: 60 },
};

describe('hyperdriveProvider', () => {
  describe('list', () => {
    it('yields configs whose name matches the k1c- prefix', async () => {
      const mock = buildMock();
      mock.list.mockReturnValueOnce(
        pageOf([
          { id: 'h1', name: 'k1c-default-app-db' },
          { id: 'h2', name: 'unmanaged-config' },
        ]),
      );
      const result = await collect(hyperdriveProvider.list(buildCtx(mock)));
      expect(result).toEqual([{ nativeId: 'h1', label: 'default/app-db' }]);
    });
  });

  describe('read', () => {
    it('returns properties with a sentinel password (CF never returns it)', async () => {
      const mock = buildMock();
      mock.get.mockResolvedValueOnce({
        id: 'h1',
        name: 'k1c-default-app-db',
        origin: {
          scheme: 'postgres',
          host: 'db.internal',
          port: 5432,
          database: 'app',
          user: 'app',
        },
      });
      const props = await hyperdriveProvider.read(buildCtx(mock), 'h1');
      expect(props).not.toBe(NotFound);
      const p = props as unknown as Record<string, unknown>;
      expect((p.origin as Record<string, unknown>).password).toBe('<write-only>');
    });

    it('returns NotFound on 404', async () => {
      const mock = buildMock();
      mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
      expect(await hyperdriveProvider.read(buildCtx(mock), 'h1')).toBe(NotFound);
    });
  });

  describe('create', () => {
    it('uploads name + origin (snake_case caching keys)', async () => {
      const mock = buildMock();
      mock.create.mockResolvedValueOnce({ id: 'h-new' });
      const result = await hyperdriveProvider.create(buildCtx(mock), 'default/app-db', desiredProps);
      expect(result).toMatchObject({ kind: 'sync', nativeId: 'h-new' });
      const arg = mock.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.account_id).toBe('acc-123');
      expect(arg.name).toBe('k1c-default-app-db');
      expect((arg.origin as Record<string, unknown>).password).toBe('hunter2');
      expect(arg.caching).toEqual({ disabled: false, max_age: 60 });
    });
  });

  describe('update', () => {
    it('issues a PUT to the hyperdrive id', async () => {
      const mock = buildMock();
      mock.update.mockResolvedValueOnce({ id: 'h1' });
      await hyperdriveProvider.update(buildCtx(mock), 'h1', desiredProps, {
        ...desiredProps,
        origin: { ...desiredProps.origin, host: 'db2.internal' },
      });
      expect(mock.update).toHaveBeenCalledWith(
        'h1',
        expect.objectContaining({
          account_id: 'acc-123',
          origin: expect.objectContaining({ host: 'db2.internal' }),
        }),
      );
    });
  });

  describe('delete', () => {
    it('calls SDK delete with the id', async () => {
      const mock = buildMock();
      mock.delete.mockResolvedValueOnce(undefined);
      const result = await hyperdriveProvider.delete(buildCtx(mock), 'h1');
      expect(result).toEqual({ kind: 'sync' });
      expect(mock.delete).toHaveBeenCalledWith('h1', { account_id: 'acc-123' });
    });
  });
});
