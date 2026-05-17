import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { zoneProvider } from './zone.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function ctx(cf: unknown): ProviderContext {
  return {
    cloudflare: cf as Cloudflare,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

describe('zoneProvider', () => {
  it('list yields nothing (no managed-by tagging on zones)', async () => {
    const out: unknown[] = [];
    for await (const x of zoneProvider.list(ctx({}))) out.push(x);
    expect(out).toEqual([]);
  });

  it('create posts account + name and follows up with edit for paused', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'zone-1', name: 'example.com' });
    const edit = vi.fn().mockResolvedValue({});
    const r = await zoneProvider.create(ctx({ zones: { create, edit } }), 'prod/api', {
      name: 'example.com',
      paused: true,
    });
    expect(create).toHaveBeenCalledWith({
      account: { id: 'acc-123' },
      name: 'example.com',
    });
    expect(edit).toHaveBeenCalledWith({ zone_id: 'zone-1', paused: true });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'zone-1' });
  });

  it('create skips the edit follow-up when paused / vanityNameServers unset', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'zone-2', name: 'example.com' });
    const edit = vi.fn();
    await zoneProvider.create(ctx({ zones: { create, edit } }), 'prod/api', {
      name: 'example.com',
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('update edits the existing zone', async () => {
    const edit = vi.fn().mockResolvedValue({});
    const r = await zoneProvider.update(
      ctx({ zones: { edit } }),
      'zone-1',
      { name: 'example.com' },
      { name: 'example.com', paused: true, type: 'partial' },
    );
    expect(edit).toHaveBeenCalledWith({ zone_id: 'zone-1', paused: true, type: 'partial' });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'zone-1' });
  });

  it('update rejects a domain name change with NotUpdatable + recreate', async () => {
    await expect(
      zoneProvider.update(
        ctx({ zones: { edit: vi.fn() } }),
        'zone-1',
        { name: 'old.example.com' },
        { name: 'new.example.com' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('delete passes zone_id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await zoneProvider.delete(ctx({ zones: { delete: del } }), 'zone-1');
    expect(del).toHaveBeenCalledWith({ zone_id: 'zone-1' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await zoneProvider.read(ctx({ zones: { get } }), 'zone-gone');
    expect(r).toBe(NotFound);
  });

  it('equals normalizes defaults (paused / vanity NS order)', () => {
    const eq = zoneProvider.equals!;
    expect(
      eq(
        { name: 'example.com', vanityNameServers: ['ns2.example.com', 'ns1.example.com'] },
        { name: 'example.com', paused: false, vanityNameServers: ['ns1.example.com', 'ns2.example.com'] },
      ),
    ).toBe(true);
  });
});
