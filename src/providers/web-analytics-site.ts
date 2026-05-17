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
 * Cloudflare RUM (Web Analytics) site registration. One Site per
 * tracked hostname; Cloudflare allocates `site_tag` (the public id used
 * as the JS snippet's data attribute) at create time.
 *
 * The site nativeId == `site_tag`. The token / snippet returned at
 * create time are *not* persisted on the CR — they can be re-read via
 * `k1c get webanalyticssite <name>` which calls get under the hood.
 *
 * Web Analytics sites have no managed-by metadata, so list() yields
 * nothing; adoption is opt-in via explicit nativeId on the CR.
 */
export interface WebAnalyticsSiteProperties {
  /** Hostname for gray-clouded sites. Optional when zoneTag is set. */
  readonly host?: string;
  /** Zone tag for orange-clouded sites. */
  readonly zoneTag?: string;
  /** Auto-inject the RUM JS snippet on orange-clouded sites. */
  readonly autoInstall?: boolean;
}

export const webAnalyticsSitePropertiesSchema: z.ZodType<WebAnalyticsSiteProperties> = z
  .object({
    host: z.string().optional(),
    zoneTag: z.string().optional(),
    autoInstall: z.boolean().optional(),
  })
  .refine(
    (p) => (p.host !== undefined && p.host.length > 0) || (p.zoneTag !== undefined && p.zoneTag.length > 0),
    { message: 'host or zoneTag is required' },
  );

function normalize(p: WebAnalyticsSiteProperties): unknown {
  return {
    host: p.host ?? '',
    zoneTag: p.zoneTag ?? '',
    autoInstall: p.autoInstall ?? false,
  };
}

export const webAnalyticsSiteProvider: CloudflareResourceProvider<WebAnalyticsSiteProperties> = {
  resourceType: 'WebAnalyticsSite',
  schema: webAnalyticsSitePropertiesSchema,
  equals: makeEquals<WebAnalyticsSiteProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // RUM sites carry no managed-by metadata; adoption is opt-in via explicit nativeId.
  },

  async read(ctx, nativeId) {
    try {
      const s = (await ctx.cloudflare.rum.siteInfo.get(nativeId, {
        account_id: ctx.accountId,
      })) as Record<string, unknown>;
      return {
        ...(s['host'] !== undefined ? { host: s['host'] as string } : {}),
        ...(s['ruleset'] !== undefined && (s['ruleset'] as { zone_tag?: string }).zone_tag
          ? { zoneTag: (s['ruleset'] as { zone_tag?: string }).zone_tag! }
          : {}),
        ...(s['auto_install'] !== undefined ? { autoInstall: s['auto_install'] as boolean } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const s = (await ctx.cloudflare.rum.siteInfo.create({
        account_id: ctx.accountId,
        ...(desired.host !== undefined ? { host: desired.host } : {}),
        ...(desired.zoneTag !== undefined ? { zone_tag: desired.zoneTag } : {}),
        ...(desired.autoInstall !== undefined ? { auto_install: desired.autoInstall } : {}),
      })) as { site_tag?: string };
      const id = s.site_tag ?? '';
      if (!id) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'WebAnalyticsSite create returned no site_tag',
        };
      }
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.rum.siteInfo.update(nativeId, {
        account_id: ctx.accountId,
        ...(desired.host !== undefined ? { host: desired.host } : {}),
        ...(desired.zoneTag !== undefined ? { zone_tag: desired.zoneTag } : {}),
        ...(desired.autoInstall !== undefined ? { auto_install: desired.autoInstall } : {}),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.rum.siteInfo.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
