import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { webAnalyticsSiteProvider } from './web-analytics-site.ts';
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

describe('webAnalyticsSiteProvider', () => {
  it('list yields nothing (no managed-by tagging)', async () => {
    const out: unknown[] = [];
    for await (const x of webAnalyticsSiteProvider.list(ctx({}))) out.push(x);
    expect(out).toEqual([]);
  });

  it('create posts host + auto_install and returns site_tag', async () => {
    const create = vi.fn().mockResolvedValue({ site_tag: 'abc123' });
    const r = await webAnalyticsSiteProvider.create(
      ctx({ rum: { siteInfo: { create } } }),
      'prod/marketing',
      { host: 'www.example.com', autoInstall: true },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      host: 'www.example.com',
      auto_install: true,
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'abc123' });
  });

  it('create with zoneTag uses zone_tag in body', async () => {
    const create = vi.fn().mockResolvedValue({ site_tag: 'tok-z' });
    await webAnalyticsSiteProvider.create(
      ctx({ rum: { siteInfo: { create } } }),
      'prod/api',
      { zoneTag: 'zone-1', autoInstall: false },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      zone_tag: 'zone-1',
      auto_install: false,
    });
  });

  it('update passes the site_tag in path + body', async () => {
    const update = vi.fn().mockResolvedValue({});
    await webAnalyticsSiteProvider.update(
      ctx({ rum: { siteInfo: { update } } }),
      'abc123',
      { host: 'www.example.com' },
      { host: 'www.example.com', autoInstall: true },
    );
    expect(update).toHaveBeenCalledWith('abc123', {
      account_id: 'acc',
      host: 'www.example.com',
      auto_install: true,
    });
  });

  it('delete passes account_id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await webAnalyticsSiteProvider.delete(
      ctx({ rum: { siteInfo: { delete: del } } }),
      'abc123',
    );
    expect(del).toHaveBeenCalledWith('abc123', { account_id: 'acc' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await webAnalyticsSiteProvider.read(
      ctx({ rum: { siteInfo: { get } } }),
      'gone',
    );
    expect(r).toBe(NotFound);
  });
});
