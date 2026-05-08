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

export interface CustomDomainProperties {
  readonly hostname: string;
  readonly service: string;
  readonly zoneId: string;
  readonly environment: string;
}

export const customDomainSchema: z.ZodType<CustomDomainProperties> = z.object({
  hostname: z.string(),
  service: z.string(),
  zoneId: z.string(),
  environment: z.string(),
});

const SERVICE_PREFIX = 'k1c--';

/**
 * Cloudflare's Worker Custom Domain has no per-domain user tag for managed-by markers,
 * so ownership is inferred from `service` (the Worker script name) starting with the
 * k1c naming convention. This is good enough for v0.1.
 */
function isManaged(service: string | undefined): boolean {
  return typeof service === 'string' && service.startsWith(SERVICE_PREFIX);
}

function labelFromHostname(hostname: string | undefined): string | null {
  if (!hostname) return null;
  return hostname; // hostname is globally unique within the account, fine as-is
}

export const customDomainProvider: CloudflareResourceProvider<CustomDomainProperties> = {
  resourceType: 'CustomDomain',
  schema: customDomainSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.workers.domains.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const dom of iter) {
        if (!isManaged(dom.service)) continue;
        const label = labelFromHostname(dom.hostname);
        if (label === null || !dom.id) continue;
        yield { nativeId: dom.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const dom = await ctx.cloudflare.workers.domains.get(nativeId, {
        account_id: ctx.accountId,
      });
      if (!dom.hostname || !dom.service || !dom.zone_id) return NotFound;
      return {
        hostname: dom.hostname,
        service: dom.service,
        zoneId: dom.zone_id,
        environment: dom.environment ?? 'production',
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const dom = await ctx.cloudflare.workers.domains.update({
        account_id: ctx.accountId,
        hostname: desired.hostname,
        service: desired.service,
        zone_id: desired.zoneId,
        environment: desired.environment,
      });
      return {
        kind: 'sync',
        nativeId: dom.id ?? desired.hostname,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, _nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      // The Workers Domains API uses a single PUT for create-or-update; there is no
      // per-id update endpoint. Re-issuing the upsert is safe and idempotent.
      const dom = await ctx.cloudflare.workers.domains.update({
        account_id: ctx.accountId,
        hostname: desired.hostname,
        service: desired.service,
        zone_id: desired.zoneId,
        environment: desired.environment,
      });
      return {
        kind: 'sync',
        nativeId: dom.id ?? desired.hostname,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.workers.domains.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
