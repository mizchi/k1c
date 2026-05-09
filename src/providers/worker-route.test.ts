import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workerRouteProvider } from './worker-route.ts';
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
  const cf = { workers: { routes: mock } } as unknown as Cloudflare;
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

describe('workerRouteProvider', () => {
  it('list filters routes by k1c-- script prefix and yields pattern as label', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'rt-1', pattern: '*.example.com/*', script: 'k1c--default--web--ingress' },
        { id: 'rt-2', pattern: 'unrelated.com/*', script: 'someone-elses-worker' },
        { id: 'rt-3', pattern: 'api.example.com/*', script: 'k1c--prod--api' },
      ]),
    );
    const result = await collect(workerRouteProvider.list(buildCtx(mock)));
    expect(result).toEqual([
      { nativeId: 'rt-1', label: '*.example.com/*' },
      { nativeId: 'rt-3', label: 'api.example.com/*' },
    ]);
  });

  it('list yields nothing when ctx has no zone', async () => {
    const mock = buildMock();
    const ctx = { ...buildCtx(mock), zoneId: undefined };
    const result = await collect(workerRouteProvider.list(ctx));
    expect(result).toEqual([]);
    expect(mock.list).not.toHaveBeenCalled();
  });

  it('create sends pattern + script', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'rt-new' });
    const result = await workerRouteProvider.create(buildCtx(mock), '*.example.com/*', {
      zoneId: 'zone-abc',
      pattern: '*.example.com/*',
      scriptName: 'k1c--default--web--ingress',
    });
    expect(mock.create).toHaveBeenCalledWith({
      zone_id: 'zone-abc',
      pattern: '*.example.com/*',
      script: 'k1c--default--web--ingress',
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'rt-new' });
  });

  it('update uses route id and re-issues pattern + script', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({ id: 'rt-1' });
    await workerRouteProvider.update(
      buildCtx(mock),
      'rt-1',
      { zoneId: 'zone-abc', pattern: 'old/*', scriptName: 'k1c--default--old' },
      { zoneId: 'zone-abc', pattern: '*.example.com/*', scriptName: 'k1c--default--new' },
    );
    expect(mock.update).toHaveBeenCalledWith('rt-1', {
      zone_id: 'zone-abc',
      pattern: '*.example.com/*',
      script: 'k1c--default--new',
    });
  });

  it('read returns NotFound when ctx has no zone', async () => {
    const mock = buildMock();
    const ctx = { ...buildCtx(mock), zoneId: undefined };
    expect(await workerRouteProvider.read(ctx, 'rt-1')).toBe(NotFound);
  });

  it('delete calls SDK with route id and zone id', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await workerRouteProvider.delete(buildCtx(mock), 'rt-1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('rt-1', { zone_id: 'zone-abc' });
  });
});
