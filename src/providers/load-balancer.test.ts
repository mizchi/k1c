import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { loadBalancerMonitorProvider } from './load-balancer-monitor.ts';
import { loadBalancerPoolProvider } from './load-balancer-pool.ts';
import { loadBalancerProvider } from './load-balancer.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function makeCtx(cf: unknown, zoneId?: string): ProviderContext {
  return {
    cloudflare: cf as Cloudflare,
    accountId: 'acc',
    ...(zoneId !== undefined ? { zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
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

describe('loadBalancerMonitorProvider', () => {
  it('list yields only k1c-prefixed descriptions', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { id: 'm-1', description: 'k1c:prod/api healthcheck for api' },
        { id: 'm-2', description: 'someone-else' },
        { id: 'm-3', description: 'k1c:default/web' },
      ]),
    );
    const r = await collect(
      loadBalancerMonitorProvider.list(makeCtx({ loadBalancers: { monitors: { list } } })),
    );
    expect(r).toEqual([
      { nativeId: 'm-1', label: 'prod/api' },
      { nativeId: 'm-3', label: 'default/web' },
    ]);
  });

  it('create posts type + description and returns id', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'm-new' });
    const r = await loadBalancerMonitorProvider.create(
      makeCtx({ loadBalancers: { monitors: { create } } }),
      'prod/api',
      {
        description: 'k1c:prod/api hc',
        type: 'https',
        path: '/healthz',
        expectedCodes: '200',
      },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      description: 'k1c:prod/api hc',
      type: 'https',
      path: '/healthz',
      expected_codes: '200',
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'm-new' });
  });

  it('delete passes account_id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await loadBalancerMonitorProvider.delete(
      makeCtx({ loadBalancers: { monitors: { delete: del } } }),
      'm-1',
    );
    expect(del).toHaveBeenCalledWith('m-1', { account_id: 'acc' });
  });
});

describe('loadBalancerPoolProvider', () => {
  it('list yields only k1c-<ns>-<name> pools', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { id: 'p-1', name: 'k1c-prod-api' },
        { id: 'p-2', name: 'manual-pool' },
        { id: 'p-3', name: 'k1c-default-web' },
      ]),
    );
    const r = await collect(
      loadBalancerPoolProvider.list(makeCtx({ loadBalancers: { pools: { list } } })),
    );
    expect(r).toEqual([
      { nativeId: 'p-1', label: 'prod/api' },
      { nativeId: 'p-3', label: 'default/web' },
    ]);
  });

  it('create maps origins with snake-case keys', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p-new' });
    const r = await loadBalancerPoolProvider.create(
      makeCtx({ loadBalancers: { pools: { create } } }),
      'prod/api',
      {
        poolName: 'k1c-prod-api',
        origins: [
          { address: '1.2.3.4', name: 'edge-1', weight: 0.5 },
          { address: '5.6.7.8' },
        ],
        monitor: 'm-1',
        minimumOrigins: 2,
      },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      name: 'k1c-prod-api',
      origins: [
        { address: '1.2.3.4', name: 'edge-1', weight: 0.5 },
        { address: '5.6.7.8' },
      ],
      monitor: 'm-1',
      minimum_origins: 2,
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'p-new' });
  });

  it('equals normalizes origin order + default weight', () => {
    const eq = loadBalancerPoolProvider.equals!;
    expect(
      eq(
        {
          poolName: 'k1c-prod-api',
          origins: [
            { address: 'b' },
            { address: 'a', weight: 1 },
          ],
        },
        {
          poolName: 'k1c-prod-api',
          origins: [
            { address: 'a' },
            { address: 'b' },
          ],
        },
      ),
    ).toBe(true);
  });
});

describe('loadBalancerProvider', () => {
  it('list yields only k1c-prefixed descriptions when zoneId is known', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { id: 'lb-1', description: 'k1c:prod/api the api LB' },
        { id: 'lb-2', description: 'unrelated' },
      ]),
    );
    const r = await collect(
      loadBalancerProvider.list(makeCtx({ loadBalancers: { list } }, 'zone-1')),
    );
    expect(list).toHaveBeenCalledWith({ zone_id: 'zone-1' });
    expect(r).toEqual([{ nativeId: 'lb-1', label: 'prod/api' }]);
  });

  it('list yields nothing when no zoneId is available', async () => {
    const list = vi.fn();
    const r = await collect(loadBalancerProvider.list(makeCtx({ loadBalancers: { list } })));
    expect(list).not.toHaveBeenCalled();
    expect(r).toEqual([]);
  });

  it('create posts zone_id + body', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'lb-new' });
    const r = await loadBalancerProvider.create(
      makeCtx({ loadBalancers: { create } }),
      'prod/api',
      {
        zoneId: 'zone-1',
        name: 'api.example.com',
        defaultPools: ['p-1', 'p-2'],
        fallbackPool: 'p-1',
        description: 'k1c:prod/api',
        proxied: true,
        steeringPolicy: 'dynamic_latency',
      },
    );
    expect(create).toHaveBeenCalledWith({
      zone_id: 'zone-1',
      name: 'api.example.com',
      default_pools: ['p-1', 'p-2'],
      fallback_pool: 'p-1',
      description: 'k1c:prod/api',
      proxied: true,
      steering_policy: 'dynamic_latency',
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'lb-new' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await loadBalancerProvider.read(
      makeCtx({ loadBalancers: { get } }, 'zone-1'),
      'lb-gone',
    );
    expect(r).toBe(NotFound);
  });
});
