import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { certificatePackProvider } from './certificate-pack.ts';
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

describe('certificatePackProvider', () => {
  it('create posts with snake_case + returns joined nativeId', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'pack-1' });
    const r = await certificatePackProvider.create(
      ctx({ ssl: { certificatePacks: { create } } }),
      'prod/api',
      {
        zoneId: 'zone-1',
        certificateAuthority: 'google',
        hosts: ['example.com', '*.example.com'],
        type: 'advanced',
        validationMethod: 'txt',
        validityDays: 90,
      },
    );
    expect(create).toHaveBeenCalledWith({
      zone_id: 'zone-1',
      certificate_authority: 'google',
      hosts: ['example.com', '*.example.com'],
      type: 'advanced',
      validation_method: 'txt',
      validity_days: 90,
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'zone-1::pack-1' });
  });

  it('update rejects host/CA/validity changes with NotUpdatable + recreate', async () => {
    await expect(
      certificatePackProvider.update(
        ctx({ ssl: { certificatePacks: {} } }),
        'zone-1::pack-1',
        {
          zoneId: 'zone-1',
          certificateAuthority: 'lets_encrypt',
          hosts: ['example.com'],
          type: 'advanced',
          validationMethod: 'txt',
          validityDays: 90,
        },
        {
          zoneId: 'zone-1',
          certificateAuthority: 'lets_encrypt',
          hosts: ['example.com', 'api.example.com'],
          type: 'advanced',
          validationMethod: 'txt',
          validityDays: 90,
        },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('update only toggling cloudflareBranding calls edit', async () => {
    const edit = vi.fn().mockResolvedValue({});
    const r = await certificatePackProvider.update(
      ctx({ ssl: { certificatePacks: { edit } } }),
      'zone-1::pack-1',
      {
        zoneId: 'zone-1',
        certificateAuthority: 'lets_encrypt',
        hosts: ['example.com'],
        type: 'advanced',
        validationMethod: 'txt',
        validityDays: 90,
      },
      {
        zoneId: 'zone-1',
        certificateAuthority: 'lets_encrypt',
        hosts: ['example.com'],
        type: 'advanced',
        validationMethod: 'txt',
        validityDays: 90,
        cloudflareBranding: true,
      },
    );
    expect(edit).toHaveBeenCalledWith('pack-1', { zone_id: 'zone-1', cloudflare_branding: true });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'zone-1::pack-1' });
  });

  it('delete passes zone_id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await certificatePackProvider.delete(
      ctx({ ssl: { certificatePacks: { delete: del } } }),
      'zone-1::pack-1',
    );
    expect(del).toHaveBeenCalledWith('pack-1', { zone_id: 'zone-1' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await certificatePackProvider.read(
      ctx({ ssl: { certificatePacks: { get } } }),
      'zone-1::gone',
    );
    expect(r).toBe(NotFound);
  });
});
