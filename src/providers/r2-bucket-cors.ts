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

export type R2CorsMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';

export interface R2CorsRule {
  readonly id?: string;
  readonly allowed: {
    readonly methods: ReadonlyArray<R2CorsMethod>;
    readonly origins: ReadonlyArray<string>;
    readonly headers?: ReadonlyArray<string>;
  };
  readonly exposeHeaders?: ReadonlyArray<string>;
  readonly maxAgeSeconds?: number;
}

export interface R2BucketCorsProperties {
  readonly bucketName: string;
  readonly rules: ReadonlyArray<R2CorsRule>;
}

const corsRuleSchema: z.ZodType<R2CorsRule> = z.object({
  id: z.string().optional(),
  allowed: z.object({
    methods: z.array(z.enum(['GET', 'PUT', 'POST', 'DELETE', 'HEAD'])),
    origins: z.array(z.string()),
    headers: z.array(z.string()).optional(),
  }),
  exposeHeaders: z.array(z.string()).optional(),
  maxAgeSeconds: z.number().int().nonnegative().optional(),
});

export const r2BucketCorsPropertiesSchema: z.ZodType<R2BucketCorsProperties> = z.object({
  bucketName: z.string(),
  rules: z.array(corsRuleSchema),
});

function normalize(p: R2BucketCorsProperties): unknown {
  return {
    bucketName: p.bucketName,
    rules: p.rules.map((r) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      allowed: {
        methods: [...r.allowed.methods].sort(),
        origins: [...r.allowed.origins].sort(),
        ...(r.allowed.headers ? { headers: [...r.allowed.headers].sort() } : {}),
      },
      ...(r.exposeHeaders ? { exposeHeaders: [...r.exposeHeaders].sort() } : {}),
      ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
    })),
  };
}

export const r2BucketCorsProvider: CloudflareResourceProvider<R2BucketCorsProperties> = {
  resourceType: 'R2BucketCors',
  schema: r2BucketCorsPropertiesSchema,
  equals: makeEquals<R2BucketCorsProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // CORS lives on each bucket. Cluster-wide listing would require
    // walking every bucket; rely on read+diff for known bucketNames.
  },

  async read(ctx, nativeId) {
    try {
      const resp = await ctx.cloudflare.r2.buckets.cors.get(nativeId, {
        account_id: ctx.accountId,
      });
      return {
        bucketName: nativeId,
        rules: (resp.rules ?? []).map((r) => ({
          ...(r.id !== undefined ? { id: r.id } : {}),
          allowed: {
            methods: r.allowed.methods,
            origins: r.allowed.origins,
            ...(r.allowed.headers ? { headers: r.allowed.headers } : {}),
          },
          ...(r.exposeHeaders ? { exposeHeaders: r.exposeHeaders } : {}),
          ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
        })),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      await ctx.cloudflare.r2.buckets.cors.update(desired.bucketName, {
        account_id: ctx.accountId,
        rules: desired.rules.map((r) => ({
          ...(r.id !== undefined ? { id: r.id } : {}),
          allowed: {
            methods: [...r.allowed.methods],
            origins: [...r.allowed.origins],
            ...(r.allowed.headers ? { headers: [...r.allowed.headers] } : {}),
          },
          ...(r.exposeHeaders ? { exposeHeaders: [...r.exposeHeaders] } : {}),
          ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
        })),
      });
      return { kind: 'sync', nativeId: desired.bucketName, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.r2.buckets.cors.update(nativeId, {
        account_id: ctx.accountId,
        rules: desired.rules.map((r) => ({
          ...(r.id !== undefined ? { id: r.id } : {}),
          allowed: {
            methods: [...r.allowed.methods],
            origins: [...r.allowed.origins],
            ...(r.allowed.headers ? { headers: [...r.allowed.headers] } : {}),
          },
          ...(r.exposeHeaders ? { exposeHeaders: [...r.exposeHeaders] } : {}),
          ...(r.maxAgeSeconds !== undefined ? { maxAgeSeconds: r.maxAgeSeconds } : {}),
        })),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.r2.buckets.cors.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
