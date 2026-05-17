import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { notificationPolicyProvider } from './notification-policy.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function ctx(cf: unknown): ProviderContext {
  return {
    cloudflare: cf as Cloudflare,
    accountId: 'acc',
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

describe('notificationPolicyProvider', () => {
  it('list yields only k1c-<ns>-<name> rows', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { id: 'p-1', name: 'k1c-prod-api-errors' },
        { id: 'p-2', name: 'manual-policy' },
      ]),
    );
    const r = await collect(notificationPolicyProvider.list(ctx({ alerting: { policies: { list } } })));
    expect(r).toEqual([{ nativeId: 'p-1', label: 'prod/api-errors' }]);
  });

  it('create maps mechanisms + alert_type with snake_case', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p-new' });
    const r = await notificationPolicyProvider.create(
      ctx({ alerting: { policies: { create } } }),
      'prod/api-errors',
      {
        policyName: 'k1c-prod-api-errors',
        alertType: 'http_alert_origin_error',
        enabled: true,
        mechanisms: { email: [{ id: 'sre@example.com' }] },
        alertInterval: '5m',
        filters: { event_type: ['error'] },
      },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      name: 'k1c-prod-api-errors',
      alert_type: 'http_alert_origin_error',
      enabled: true,
      mechanisms: { email: [{ id: 'sre@example.com' }] },
      alert_interval: '5m',
      filters: { event_type: ['error'] },
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'p-new' });
  });

  it('delete passes account_id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await notificationPolicyProvider.delete(
      ctx({ alerting: { policies: { delete: del } } }),
      'p-1',
    );
    expect(del).toHaveBeenCalledWith('p-1', { account_id: 'acc' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await notificationPolicyProvider.read(
      ctx({ alerting: { policies: { get } } }),
      'gone',
    );
    expect(r).toBe(NotFound);
  });

  it('equals normalizes mechanism order + missing optionals', () => {
    const eq = notificationPolicyProvider.equals!;
    expect(
      eq(
        {
          policyName: 'k1c-p-a',
          alertType: 't',
          enabled: true,
          mechanisms: { email: [{ id: 'b@x' }, { id: 'a@x' }] },
        },
        {
          policyName: 'k1c-p-a',
          alertType: 't',
          enabled: true,
          mechanisms: { email: [{ id: 'a@x' }, { id: 'b@x' }] },
        },
      ),
    ).toBe(true);
  });
});
