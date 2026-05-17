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

export type R2MinTls = '1.0' | '1.1' | '1.2' | '1.3';

export interface R2CustomDomainProperties {
  readonly bucketName: string;
  readonly domain: string;
  readonly zoneId: string;
  readonly enabled: boolean;
  readonly minTLS?: R2MinTls;
}

export const r2CustomDomainPropertiesSchema: z.ZodType<R2CustomDomainProperties> = z.object({
  bucketName: z.string(),
  domain: z.string(),
  zoneId: z.string(),
  enabled: z.boolean(),
  minTLS: z.enum(['1.0', '1.1', '1.2', '1.3']).optional(),
});

function normalize(p: R2CustomDomainProperties): unknown {
  return {
    bucketName: p.bucketName,
    domain: p.domain,
    zoneId: p.zoneId,
    enabled: p.enabled,
    minTLS: p.minTLS ?? '1.0',
  };
}

function splitNativeId(nativeId: string): { bucketName: string; domain: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed R2CustomDomain nativeId: ${nativeId}`);
  return { bucketName: nativeId.slice(0, sep), domain: nativeId.slice(sep + 2) };
}

export const r2CustomDomainProvider: CloudflareResourceProvider<R2CustomDomainProperties> = {
  resourceType: 'R2CustomDomain',
  schema: r2CustomDomainPropertiesSchema,
  equals: makeEquals<R2CustomDomainProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Custom domains live under each bucket; cluster-wide list would have
    // to walk every R2 bucket. Skip — drift caught by read.
  },

  async read(ctx, nativeId) {
    const { bucketName, domain } = splitNativeId(nativeId);
    try {
      const resp = await ctx.cloudflare.r2.buckets.domains.custom.get(bucketName, domain, {
        account_id: ctx.accountId,
      });
      return {
        bucketName,
        domain: resp.domain,
        zoneId: resp.zoneId ?? '',
        enabled: resp.enabled,
        ...(resp.minTLS ? { minTLS: resp.minTLS } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      await ctx.cloudflare.r2.buckets.domains.custom.create(desired.bucketName, {
        account_id: ctx.accountId,
        domain: desired.domain,
        enabled: desired.enabled,
        zoneId: desired.zoneId,
        ...(desired.minTLS ? { minTLS: desired.minTLS } : {}),
      });
      return {
        kind: 'sync',
        nativeId: `${desired.bucketName}::${desired.domain}`,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    const { bucketName, domain } = splitNativeId(nativeId);
    try {
      await ctx.cloudflare.r2.buckets.domains.custom.update(bucketName, domain, {
        account_id: ctx.accountId,
        enabled: desired.enabled,
        ...(desired.minTLS ? { minTLS: desired.minTLS } : {}),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    const { bucketName, domain } = splitNativeId(nativeId);
    try {
      await ctx.cloudflare.r2.buckets.domains.custom.delete(bucketName, domain, {
        account_id: ctx.accountId,
      });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
