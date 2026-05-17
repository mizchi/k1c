import { z } from 'zod';
import type {
  CloudflareResourceProvider,
  CreateResult,
  DeleteResult,
  ListedResource,
  ProviderContext,
  UpdateResult,
} from './types.ts';
import { NotFound } from './types.ts';
import { toProviderError } from './errors.ts';
import { makeEquals } from './_equality.ts';

/**
 * Per-zone setting toggle (always_use_https, brotli, min_tls_version, ssl,
 * security_level, http3, ...). The Cloudflare SDK exposes ~50 typed setting
 * names via `zones.settings.edit(settingId, { zone_id, value })`; we model
 * them as a single CRD parameterized by settingId rather than 50 CRDs.
 *
 * nativeId = `${zoneId}::${settingId}`. Settings cannot be "deleted" — only
 * reset to their default value — so delete() is a no-op + the CR removal
 * just stops k1c from enforcing the value; the previously-set value sticks.
 * If you want to reset, set value to the Cloudflare default explicitly
 * before removing the CR.
 *
 * value is intentionally `unknown` because the per-setting payload shape
 * varies wildly (boolean for always_use_https, string for min_tls_version,
 * { strict_transport_security: {...} } for security_header, etc.). The
 * SDK enforces the per-setting type at runtime.
 */
export interface ZoneSettingProperties {
  readonly zoneId: string;
  /** Setting key — see Cloudflare docs for the list (always_use_https, ssl, brotli, http3, etc.). */
  readonly settingId: string;
  /** The desired value. Shape depends on the setting. */
  readonly value?: unknown;
}

export const zoneSettingPropertiesSchema: z.ZodType<ZoneSettingProperties> = z.object({
  zoneId: z.string(),
  settingId: z.string(),
  value: z.unknown(),
});

function normalize(p: ZoneSettingProperties): unknown {
  return { zoneId: p.zoneId, settingId: p.settingId, value: p.value };
}

function splitNativeId(nativeId: string): { zoneId: string; settingId: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed ZoneSetting nativeId: ${nativeId}`);
  return { zoneId: nativeId.slice(0, sep), settingId: nativeId.slice(sep + 2) };
}

export const zoneSettingProvider: CloudflareResourceProvider<ZoneSettingProperties> = {
  resourceType: 'ZoneSetting',
  schema: zoneSettingPropertiesSchema,
  equals: makeEquals<ZoneSettingProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Settings exist for every zone whether k1c manages them or not;
    // enumerating would yield false positives. Rely on read on the
    // explicit nativeId stored on the CR.
  },

  async read(ctx, nativeId) {
    const { zoneId, settingId } = splitNativeId(nativeId);
    try {
      const s = (await ctx.cloudflare.zones.settings.get(settingId, { zone_id: zoneId })) as {
        value?: unknown;
      };
      return { zoneId, settingId, value: s.value };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    await putSetting(ctx, desired);
    return {
      kind: 'sync',
      nativeId: `${desired.zoneId}::${desired.settingId}`,
      properties: desired,
    };
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    await putSetting(ctx, desired);
    return { kind: 'sync', nativeId, properties: desired };
  },

  async delete(_ctx, _nativeId): Promise<DeleteResult> {
    // Cloudflare zone settings have no DELETE endpoint; removing the CR
    // stops k1c reconciling the value but the last-applied value persists
    // on Cloudflare. Reset explicitly via a CR with value: <default> before
    // removing.
    return { kind: 'sync' };
  },
};

async function putSetting(ctx: ProviderContext, desired: ZoneSettingProperties): Promise<void> {
  try {
    await ctx.cloudflare.zones.settings.edit(
      desired.settingId,
      { zone_id: desired.zoneId, value: desired.value } as never,
    );
  } catch (raw) {
    throw toProviderError(raw);
  }
}
