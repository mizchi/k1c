import { describe, expect, it } from 'vitest';
import { pageRuleLabel, pageRuleProvider } from './page-rule.ts';
import type { ProviderContext } from './types.ts';

function fakeCtx(zoneId: string | undefined, fakePageRules: Record<string, unknown>): ProviderContext {
  return {
    cloudflare: { pageRules: fakePageRules } as unknown as ProviderContext['cloudflare'],
    accountId: 'acct',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=test',
    signal: new AbortController().signal,
    ...(zoneId !== undefined ? { zoneId } : {}),
  };
}

describe('pageRuleLabel', () => {
  it('joins zone, url, priority with double colons', () => {
    expect(pageRuleLabel('z', 'https://x/*', 1)).toBe('z::https://x/*::1');
  });
});

describe('pageRuleProvider', () => {
  it('list yields rules synthesised label keyed on (zone, url, priority)', async () => {
    const ctx = fakeCtx('zone-1', {
      list: async () => ({
        result: [
          {
            id: 'rule-a',
            priority: 5,
            status: 'active',
            targets: [{ target: 'url', constraint: { operator: 'matches', value: '*.example.com/*' } }],
            actions: [{ id: 'always_use_https' }],
          },
          {
            id: 'rule-b',
            priority: 1,
            status: 'disabled',
            targets: [{ target: 'url', constraint: { operator: 'matches', value: 'old.example.com/*' } }],
            actions: [{ id: 'forwarding_url', value: { url: 'https://new.example.com', status_code: 301 } }],
          },
          // No URL target — silently skipped.
          { id: 'rule-c', priority: 1, targets: [{ target: 'host' }], actions: [] },
        ],
      }),
    });
    const out = [];
    for await (const item of pageRuleProvider.list(ctx)) out.push(item);
    expect(out).toEqual([
      { nativeId: 'rule-a', label: 'zone-1::*.example.com/*::5' },
      { nativeId: 'rule-b', label: 'zone-1::old.example.com/*::1' },
    ]);
  });

  it('list yields nothing when no zoneId is bound', async () => {
    const ctx = fakeCtx(undefined, {
      list: async () => {
        throw new Error('should not be called');
      },
    });
    const out = [];
    for await (const item of pageRuleProvider.list(ctx)) out.push(item);
    expect(out).toEqual([]);
  });

  it('create rejects when zoneId is missing', async () => {
    const ctx = fakeCtx(undefined, {
      create: async () => ({ id: 'should-not-create' }),
    });
    await expect(
      pageRuleProvider.create(ctx, 'default/test', {
        url: '*.example.com/*',
        actions: [{ id: 'always_use_https' }],
      }),
    ).rejects.toMatchObject({ code: 'BadRequest' });
  });

  it('create wires url + actions + priority through buildBody', async () => {
    let captured: unknown;
    const ctx = fakeCtx('zone-1', {
      create: async (body: unknown) => {
        captured = body;
        return { id: 'rule-new' };
      },
    });
    const result = await pageRuleProvider.create(ctx, 'default/redirect', {
      url: '*.example.com/old/*',
      priority: 10,
      status: 'active',
      actions: [
        { id: 'forwarding_url', value: { url: 'https://example.com/new', status_code: 301 } },
      ],
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'rule-new' });
    expect(captured).toMatchObject({
      zone_id: 'zone-1',
      priority: 10,
      status: 'active',
      targets: [
        { target: 'url', constraint: { operator: 'matches', value: '*.example.com/old/*' } },
      ],
      actions: [
        { id: 'forwarding_url', value: { url: 'https://example.com/new', status_code: 301 } },
      ],
    });
  });

  it('delete is idempotent: 404 is treated as success', async () => {
    const ctx = fakeCtx('zone-1', {
      delete: async () => {
        throw { status: 404, code: 'not-found' };
      },
    });
    const result = await pageRuleProvider.delete(ctx, 'rule-gone');
    expect(result).toEqual({ kind: 'sync' });
  });
});
