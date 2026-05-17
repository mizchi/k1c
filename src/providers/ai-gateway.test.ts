import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { aiGatewayProvider } from './ai-gateway.ts';
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
  const cf = { aiGateway: mock } as unknown as Cloudflare;
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

const baseProps = {
  id: 'k1c-default-chat',
  cacheInvalidateOnUpdate: false,
  cacheTtl: null,
  collectLogs: true,
  rateLimiting: {
    interval: null,
    limit: null,
    technique: 'fixed',
  },
} as const;

describe('aiGatewayProvider', () => {
  it('list yields only gateways with k1c- prefix', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'k1c-default-chat' },
        { id: 'default' },
      ]),
    );
    const result = await collect(aiGatewayProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'k1c-default-chat', label: 'default/chat' }]);
  });

  it('read returns properties for an existing gateway', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      id: 'k1c-default-chat',
      cache_invalidate_on_update: true,
      cache_ttl: 60,
      collect_logs: true,
      rate_limiting_interval: 60,
      rate_limiting_limit: 120,
      rate_limiting_technique: 'sliding',
      authentication: true,
      log_management: 1000,
      log_management_strategy: 'DELETE_OLDEST',
      logpush: true,
      logpush_public_key: 'pub-key',
    });
    const props = await aiGatewayProvider.read(buildCtx(mock), 'k1c-default-chat');
    expect(props).toEqual({
      id: 'k1c-default-chat',
      cacheInvalidateOnUpdate: true,
      cacheTtl: 60,
      collectLogs: true,
      rateLimiting: { interval: 60, limit: 120, technique: 'sliding' },
      authentication: true,
      logManagement: { retention: 1000, strategy: 'DELETE_OLDEST' },
      logpush: { enabled: true, publicKey: 'pub-key' },
    });
  });

  it('read returns NotFound on 404', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
    expect(await aiGatewayProvider.read(buildCtx(mock), 'k1c-default-chat')).toBe(NotFound);
  });

  it('create calls SDK with gateway body', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'k1c-default-chat' });
    await aiGatewayProvider.create(buildCtx(mock), 'default/chat', baseProps);
    expect(mock.create).toHaveBeenCalledWith({
      account_id: 'acc-123',
      id: 'k1c-default-chat',
      cache_invalidate_on_update: false,
      cache_ttl: null,
      collect_logs: true,
      rate_limiting_interval: null,
      rate_limiting_limit: null,
      rate_limiting_technique: 'fixed',
    });
  });

  it('update calls SDK with gateway body', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({ id: 'k1c-default-chat' });
    await aiGatewayProvider.update(
      buildCtx(mock),
      'k1c-default-chat',
      baseProps,
      {
        ...baseProps,
        cacheTtl: 60,
        rateLimiting: { interval: 60, limit: 120, technique: 'sliding' },
      },
    );
    expect(mock.update).toHaveBeenCalledWith('k1c-default-chat', {
      account_id: 'acc-123',
      cache_invalidate_on_update: false,
      cache_ttl: 60,
      collect_logs: true,
      rate_limiting_interval: 60,
      rate_limiting_limit: 120,
      rate_limiting_technique: 'sliding',
    });
  });

  it('delete calls SDK with gateway id', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await aiGatewayProvider.delete(buildCtx(mock), 'k1c-default-chat');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('k1c-default-chat', { account_id: 'acc-123' });
  });
});
