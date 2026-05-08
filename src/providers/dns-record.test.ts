import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { dnsRecordProvider } from './dns-record.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls, zoneId = 'zone-abc'): ProviderContext {
  const cf = { dns: { records: mock } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    zoneId,
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

describe('dnsRecordProvider', () => {
  it('list filters records by k1c.io/managed= comment', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'r1', comment: 'k1c.io/managed=default/api-cname' },
        { id: 'r2', comment: 'someone else' },
      ]),
    );
    const result = await collect(dnsRecordProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'r1', label: 'default/api-cname' }]);
  });

  it('create sends type / name / content + comment label', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'r-new' });
    await dnsRecordProvider.create(buildCtx(mock), 'default/api-cname', {
      zoneId: 'zone-abc',
      type: 'CNAME',
      name: 'api.example.com',
      content: 'api.workers.dev',
      proxied: true,
    });
    expect(mock.create).toHaveBeenCalledWith({
      zone_id: 'zone-abc',
      type: 'CNAME',
      name: 'api.example.com',
      content: 'api.workers.dev',
      comment: 'k1c.io/managed=default/api-cname',
      proxied: true,
    });
  });

  it('read returns NotFound when ctx has no zoneId', async () => {
    const mock = buildMock();
    const ctx = { ...buildCtx(mock), zoneId: undefined };
    expect(await dnsRecordProvider.read(ctx, 'r1')).toBe(NotFound);
  });

  it('delete calls SDK with record id and zone id', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await dnsRecordProvider.delete(buildCtx(mock), 'r1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('r1', { zone_id: 'zone-abc' });
  });
});
