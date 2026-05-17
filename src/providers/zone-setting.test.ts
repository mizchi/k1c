import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { zoneSettingProvider } from './zone-setting.ts';
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

describe('zoneSettingProvider', () => {
  it('create dispatches edit(settingId, { zone_id, value }) and returns joined nativeId', async () => {
    const edit = vi.fn().mockResolvedValue({});
    const r = await zoneSettingProvider.create(
      ctx({ zones: { settings: { edit, get: vi.fn() } } }),
      'prod/min-tls',
      { zoneId: 'zone-1', settingId: 'min_tls_version', value: '1.2' },
    );
    expect(edit).toHaveBeenCalledWith('min_tls_version', {
      zone_id: 'zone-1',
      value: '1.2',
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'zone-1::min_tls_version' });
  });

  it('update re-dispatches with the new value', async () => {
    const edit = vi.fn().mockResolvedValue({});
    await zoneSettingProvider.update(
      ctx({ zones: { settings: { edit, get: vi.fn() } } }),
      'zone-1::always_use_https',
      { zoneId: 'zone-1', settingId: 'always_use_https', value: false },
      { zoneId: 'zone-1', settingId: 'always_use_https', value: true },
    );
    expect(edit).toHaveBeenCalledWith('always_use_https', {
      zone_id: 'zone-1',
      value: true,
    });
  });

  it('delete is a no-op (Cloudflare has no DELETE for settings)', async () => {
    const r = await zoneSettingProvider.delete(ctx({}), 'zone-1::ssl');
    expect(r).toEqual({ kind: 'sync' });
  });

  it('read parses split nativeId and returns value', async () => {
    const get = vi.fn().mockResolvedValue({ value: '1.3' });
    const r = await zoneSettingProvider.read(
      ctx({ zones: { settings: { edit: vi.fn(), get } } }),
      'zone-1::min_tls_version',
    );
    expect(get).toHaveBeenCalledWith('min_tls_version', { zone_id: 'zone-1' });
    expect(r).toEqual({ zoneId: 'zone-1', settingId: 'min_tls_version', value: '1.3' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await zoneSettingProvider.read(
      ctx({ zones: { settings: { edit: vi.fn(), get } } }),
      'zone-1::unknown',
    );
    expect(r).toBe(NotFound);
  });

  it('rejects malformed nativeId on read', async () => {
    await expect(
      zoneSettingProvider.read(ctx({ zones: { settings: {} } }), 'no-separator-here'),
    ).rejects.toThrow(/malformed ZoneSetting nativeId/);
  });
});
