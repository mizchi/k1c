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

export type R2Location = 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';

export interface R2BucketProperties {
  readonly bucketName: string;
  readonly location?: R2Location;
  readonly storageClass?: 'Standard' | 'InfrequentAccess';
}

export const r2BucketSchema: z.ZodType<R2BucketProperties> = z.object({
  bucketName: z.string(),
  location: z.enum(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']).optional(),
  storageClass: z.enum(['Standard', 'InfrequentAccess']).optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  const namespace = rest.slice(0, dash);
  const objectName = rest.slice(dash + 1);
  return `${namespace}/${objectName}`;
}

export const r2BucketProvider: CloudflareResourceProvider<R2BucketProperties> = {
  resourceType: 'R2Bucket',
  schema: r2BucketSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let response;
    try {
      response = await ctx.cloudflare.r2.buckets.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    for (const bucket of response.buckets ?? []) {
      const name = bucket.name;
      if (!name) continue;
      const label = parseLabel(name);
      if (label === null) continue;
      yield { nativeId: name, label };
    }
  },

  async read(ctx, nativeId) {
    try {
      const bucket = await ctx.cloudflare.r2.buckets.get(nativeId, { account_id: ctx.accountId });
      // Cloudflare returns location codes uppercase (`WEUR`); the
      // manifest schema uses lowercase (`weur`). Normalize on read so
      // diff doesn't flag every existing bucket as drifting and try
      // an UPDATE that the API would reject as immutable.
      const location =
        typeof bucket.location === 'string'
          ? (bucket.location.toLowerCase() as R2Location)
          : undefined;
      const props: R2BucketProperties = {
        bucketName: bucket.name ?? nativeId,
        ...(location ? { location } : {}),
        ...(bucket.storage_class ? { storageClass: bucket.storage_class } : {}),
      };
      return props;
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const result = await ctx.cloudflare.r2.buckets.create({
        account_id: ctx.accountId,
        name: desired.bucketName,
        ...(desired.location ? { locationHint: desired.location } : {}),
        ...(desired.storageClass ? { storageClass: desired.storageClass } : {}),
      });
      return {
        kind: 'sync',
        nativeId: result.name ?? desired.bucketName,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(_ctx, _nativeId, prior, desired): Promise<UpdateResult> {
    if (prior.location !== desired.location || prior.storageClass !== desired.storageClass) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message: 'R2 bucket location and storage class are immutable; recreate to change.',
      };
    }
    return { kind: 'noop' };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.r2.buckets.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
