import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { logpushJobProvider } from './logpush-job.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls, zoneId?: string): ProviderContext {
  const cf = { logpush: { jobs: mock } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    ...(zoneId !== undefined ? { zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): MockCalls => ({
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined, done: true as const }) };
    },
  }),
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

describe('logpushJobProvider', () => {
  it('list yields only jobs whose name has the k1c- prefix', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 1, name: 'k1c-default-trace' },
        { id: 2, name: 'unmanaged-job' },
      ]),
    );
    const result = await collect(logpushJobProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: '1', label: 'default/trace' }]);
  });

  it('create with zoneId scope sends zone_id', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 42 });
    await logpushJobProvider.create(buildCtx(mock, 'zone-abc'), 'default/trace', {
      jobName: 'k1c-default-trace',
      scope: { zoneId: 'zone-abc' },
      dataset: 'workers_trace_events',
      destinationConf: 'r2://my-bucket',
      enabled: true,
    });
    expect(mock.create).toHaveBeenCalledWith({
      zone_id: 'zone-abc',
      name: 'k1c-default-trace',
      dataset: 'workers_trace_events',
      destination_conf: 'r2://my-bucket',
      enabled: true,
    });
  });

  it('create with accountId scope sends account_id', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 7 });
    await logpushJobProvider.create(buildCtx(mock), 'default/audit', {
      jobName: 'k1c-default-audit',
      scope: { accountId: 'acc-x' },
      dataset: 'audit_logs',
      destinationConf: 'r2://audit',
    });
    const arg = mock.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.account_id).toBe('acc-x');
    expect(arg.zone_id).toBeUndefined();
  });

  it('read returns NotFound when both scopes 404', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValue({ status: 404 });
    expect(await logpushJobProvider.read(buildCtx(mock), '1')).toBe(NotFound);
  });

  it('delete tries account scope first', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce({});
    const result = await logpushJobProvider.delete(buildCtx(mock), '1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith(1, { account_id: 'acc-123' });
  });
});
