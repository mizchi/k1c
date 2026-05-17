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
 * Cloudflare Zone. The zone name (domain) is the user-visible handle but
 * Cloudflare assigns the opaque zone id at create time; we store the zone id
 * as nativeId so all the zone-scoped CRDs (DnsRecord, CacheRule, ...) can
 * reference it without round-tripping through the name.
 *
 * Zones can't be tagged with a managed-by label, so list() yields nothing —
 * adopting an existing zone means setting nativeId on the CR manually (or
 * importing the manifest via `k1c get zone <name>` once we add that). Drift
 * detection still works via read on the known nativeId.
 *
 * Name and account are immutable post-create (NotUpdatable). `paused`, `type`,
 * and `vanity_name_servers` are editable.
 */
export interface ZoneProperties {
  /** Apex domain — example.com */
  readonly name: string;
  /** Defaults to 'full' (Cloudflare-hosted DNS). 'partial' = CNAME setup. */
  readonly type?: 'full' | 'partial' | 'secondary' | 'internal';
  /** When true, Cloudflare proxy is disabled and only DNS is served. */
  readonly paused?: boolean;
  /** Business+ only. Custom NS hostnames presented to clients. */
  readonly vanityNameServers?: ReadonlyArray<string>;
}

export const zonePropertiesSchema: z.ZodType<ZoneProperties> = z.object({
  name: z.string(),
  type: z.enum(['full', 'partial', 'secondary', 'internal']).optional(),
  paused: z.boolean().optional(),
  vanityNameServers: z.array(z.string()).optional(),
});

function normalize(p: ZoneProperties): unknown {
  return {
    name: p.name,
    type: p.type ?? 'full',
    paused: p.paused ?? false,
    vanityNameServers: [...(p.vanityNameServers ?? [])].sort(),
  };
}

export const zoneProvider: CloudflareResourceProvider<ZoneProperties> = {
  resourceType: 'Zone',
  schema: zonePropertiesSchema,
  equals: makeEquals<ZoneProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Cloudflare zones carry no managed-by metadata; adoption is opt-in via
    // explicit nativeId on the CR.
  },

  async read(ctx, nativeId) {
    try {
      const z = await ctx.cloudflare.zones.get({ zone_id: nativeId });
      return {
        name: z.name,
        ...(z.type !== undefined ? { type: z.type as ZoneProperties['type'] } : {}),
        ...(z.paused !== undefined ? { paused: z.paused } : {}),
        ...(((z as { vanity_name_servers?: string[] }).vanity_name_servers?.length ?? 0) > 0
          ? { vanityNameServers: (z as { vanity_name_servers?: string[] }).vanity_name_servers! }
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
      const z = await ctx.cloudflare.zones.create({
        account: { id: ctx.accountId },
        name: desired.name,
        ...(desired.type !== undefined ? { type: desired.type } : {}),
      });
      const id = z.id;
      if (!id) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'Zone create returned no id',
        };
      }
      // If the user asked for paused / vanity NS, follow up with edit() —
      // the create endpoint does not accept those fields.
      if (desired.paused !== undefined || desired.vanityNameServers !== undefined) {
        await ctx.cloudflare.zones.edit({
          zone_id: id,
          ...(desired.paused !== undefined ? { paused: desired.paused } : {}),
          ...(desired.vanityNameServers !== undefined
            ? { vanity_name_servers: [...desired.vanityNameServers] }
            : {}),
        });
      }
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, prior, desired): Promise<UpdateResult> {
    if (prior.name !== desired.name) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message: 'Zone name is immutable; create a new zone to change the domain.',
      };
    }
    try {
      await ctx.cloudflare.zones.edit({
        zone_id: nativeId,
        ...(desired.paused !== undefined ? { paused: desired.paused } : {}),
        ...(desired.type !== undefined ? { type: desired.type } : {}),
        ...(desired.vanityNameServers !== undefined
          ? { vanity_name_servers: [...desired.vanityNameServers] }
          : {}),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.zones.delete({ zone_id: nativeId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
