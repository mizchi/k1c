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

/**
 * Cloudflare Advanced Certificate Manager pack. Cert packs are almost
 * fully immutable once issued — only `cloudflare_branding` can be
 * toggled via edit; changing hosts / CA / validity / validation method
 * requires a recreate (k1c surfaces this as NotUpdatable + recreate).
 *
 * nativeId = `${zoneId}::${packId}`. list() walks all packs in the
 * current zone (ctx.zoneId required) and yields every row that this
 * provider can read back; cert packs carry no managed-by metadata, so
 * tagging via list-side filtering is not possible — adoption is opt-in
 * via explicit nativeId on the CR.
 */
export type CertCA = 'google' | 'lets_encrypt' | 'ssl_com';
export type CertValidationMethod = 'txt' | 'http' | 'email';
export type CertValidityDays = 14 | 30 | 90 | 365;

export interface CertificatePackProperties {
  readonly zoneId: string;
  readonly certificateAuthority: CertCA;
  readonly hosts: ReadonlyArray<string>;
  readonly type: 'advanced';
  readonly validationMethod: CertValidationMethod;
  readonly validityDays: CertValidityDays;
  readonly cloudflareBranding?: boolean;
}

export const certificatePackPropertiesSchema: z.ZodType<CertificatePackProperties> = z.object({
  zoneId: z.string(),
  certificateAuthority: z.enum(['google', 'lets_encrypt', 'ssl_com']),
  hosts: z.array(z.string()).min(1).max(50),
  type: z.literal('advanced'),
  validationMethod: z.enum(['txt', 'http', 'email']),
  validityDays: z.union([z.literal(14), z.literal(30), z.literal(90), z.literal(365)]),
  cloudflareBranding: z.boolean().optional(),
});

function splitNativeId(nativeId: string): { zoneId: string; packId: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed CertificatePack nativeId: ${nativeId}`);
  return { zoneId: nativeId.slice(0, sep), packId: nativeId.slice(sep + 2) };
}

export const certificatePackProvider: CloudflareResourceProvider<CertificatePackProperties> = {
  resourceType: 'CertificatePack',
  schema: certificatePackPropertiesSchema,

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Cert packs have no managed-by field; adoption is opt-in via explicit nativeId.
  },

  async read(ctx, nativeId) {
    const { zoneId, packId } = splitNativeId(nativeId);
    try {
      const p = (await ctx.cloudflare.ssl.certificatePacks.get(packId, {
        zone_id: zoneId,
      })) as Record<string, unknown>;
      return {
        zoneId,
        certificateAuthority: (p['certificate_authority'] as CertCA) ?? 'lets_encrypt',
        hosts: (p['hosts'] as string[] | undefined) ?? [],
        type: 'advanced',
        validationMethod: (p['validation_method'] as CertValidationMethod) ?? 'txt',
        validityDays: (p['validity_days'] as CertValidityDays) ?? 90,
        ...(p['cloudflare_branding'] !== undefined
          ? { cloudflareBranding: p['cloudflare_branding'] as boolean }
          : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const p = (await ctx.cloudflare.ssl.certificatePacks.create({
        zone_id: desired.zoneId,
        certificate_authority: desired.certificateAuthority,
        hosts: [...desired.hosts],
        type: 'advanced',
        validation_method: desired.validationMethod,
        validity_days: desired.validityDays,
        ...(desired.cloudflareBranding !== undefined
          ? { cloudflare_branding: desired.cloudflareBranding }
          : {}),
      })) as { id?: string };
      const id = p.id ?? '';
      if (!id) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'CertificatePack create returned no id',
        };
      }
      return {
        kind: 'sync',
        nativeId: `${desired.zoneId}::${id}`,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, prior, desired): Promise<UpdateResult> {
    if (
      prior.certificateAuthority !== desired.certificateAuthority ||
      prior.validationMethod !== desired.validationMethod ||
      prior.validityDays !== desired.validityDays ||
      JSON.stringify([...prior.hosts].sort()) !== JSON.stringify([...desired.hosts].sort())
    ) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message:
          'CertificatePack hosts/CA/validity/validation method are immutable; delete and reorder.',
      };
    }
    // Only cloudflare_branding is editable in place.
    if (prior.cloudflareBranding !== desired.cloudflareBranding) {
      const { zoneId, packId } = splitNativeId(nativeId);
      try {
        await ctx.cloudflare.ssl.certificatePacks.edit(packId, {
          zone_id: zoneId,
          ...(desired.cloudflareBranding !== undefined
            ? { cloudflare_branding: desired.cloudflareBranding }
            : {}),
        });
        return { kind: 'sync', nativeId, properties: desired };
      } catch (raw) {
        throw toProviderError(raw);
      }
    }
    return { kind: 'noop' };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    const { zoneId, packId } = splitNativeId(nativeId);
    try {
      await ctx.cloudflare.ssl.certificatePacks.delete(packId, { zone_id: zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
