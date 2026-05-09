import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { customHostnameProvider } from './custom-hostname.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly edit: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls, zoneId = 'zone-abc'): ProviderContext {
  const cf = { customHostnames: mock } as unknown as Cloudflare;
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
  edit: vi.fn(),
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

describe('customHostnameProvider', () => {
  it('list filters hostnames by k1c.io/managed metadata key', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'c-1', hostname: 'app.example.com', custom_metadata: { 'k1c.io/managed': 'prod/app' } },
        { id: 'c-2', hostname: 'unmanaged.example.com', custom_metadata: {} },
        { id: 'c-3', hostname: 'tenant.example.com', custom_metadata: { 'k1c.io/managed': 'default/tenant' } },
      ]),
    );
    const result = await collect(customHostnameProvider.list(buildCtx(mock)));
    expect(result).toEqual([
      { nativeId: 'c-1', label: 'prod/app' },
      { nativeId: 'c-3', label: 'default/tenant' },
    ]);
  });

  it('create returns kind=async with the new id', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'c-new', status: 'pending' });
    const result = await customHostnameProvider.create(buildCtx(mock), 'prod/app', {
      zoneId: 'zone-abc',
      hostname: 'app.example.com',
    });
    expect(result).toMatchObject({ kind: 'async', nativeId: 'c-new' });
    expect(mock.create.mock.calls[0]![0]).toMatchObject({
      zone_id: 'zone-abc',
      hostname: 'app.example.com',
      custom_metadata: { 'k1c.io/managed': 'prod/app' },
    });
  });

  it('status returns success when both hostname and ssl are active', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      id: 'c-1',
      hostname: 'app.example.com',
      status: 'active',
      ssl: { status: 'active' },
    });
    const result = await customHostnameProvider.status!(buildCtx(mock), 'c-1', 'provision');
    expect(result.kind).toBe('success');
  });

  it('status returns pending while SSL is still validating', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      id: 'c-1',
      hostname: 'app.example.com',
      status: 'pending_validation',
      ssl: { status: 'pending_validation' },
    });
    const result = await customHostnameProvider.status!(buildCtx(mock), 'c-1', 'provision');
    expect(result.kind).toBe('pending');
  });

  it('status returns failure when CF marks the hostname blocked', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      id: 'c-1',
      hostname: 'app.example.com',
      status: 'blocked',
    });
    const result = await customHostnameProvider.status!(buildCtx(mock), 'c-1', 'provision');
    expect(result.kind).toBe('failure');
  });

  it('update rejects hostname change with NotUpdatable + suggest=recreate', async () => {
    const mock = buildMock();
    await expect(
      customHostnameProvider.update(
        buildCtx(mock),
        'c-1',
        { zoneId: 'zone-abc', hostname: 'app.example.com' },
        { zoneId: 'zone-abc', hostname: 'app2.example.com' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('update edits SSL config in place and returns kind=async for re-poll', async () => {
    const mock = buildMock();
    mock.edit.mockResolvedValueOnce({ id: 'c-1', hostname: 'app.example.com', status: 'pending_validation' });
    const result = await customHostnameProvider.update(
      buildCtx(mock),
      'c-1',
      { zoneId: 'zone-abc', hostname: 'app.example.com', ssl: { method: 'http' } },
      { zoneId: 'zone-abc', hostname: 'app.example.com', ssl: { method: 'cname' } },
    );
    expect(result).toMatchObject({ kind: 'async', nativeId: 'c-1' });
    expect(mock.edit).toHaveBeenCalledWith('c-1', {
      zone_id: 'zone-abc',
      ssl: { method: 'cname' },
    });
  });

  it('delete passes hostname id and zone id to the SDK', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await customHostnameProvider.delete(buildCtx(mock), 'c-1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('c-1', { zone_id: 'zone-abc' });
  });
});
