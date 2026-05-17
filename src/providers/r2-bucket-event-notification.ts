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

export type R2EventAction =
  | 'PutObject'
  | 'CopyObject'
  | 'DeleteObject'
  | 'CompleteMultipartUpload'
  | 'LifecycleDeletion';

export interface R2EventRule {
  readonly actions: ReadonlyArray<R2EventAction>;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly description?: string;
}

export interface R2BucketEventNotificationProperties {
  readonly bucketName: string;
  readonly queueId: string;
  readonly rules: ReadonlyArray<R2EventRule>;
}

const eventActionSchema = z.enum([
  'PutObject',
  'CopyObject',
  'DeleteObject',
  'CompleteMultipartUpload',
  'LifecycleDeletion',
]);

const ruleSchema: z.ZodType<R2EventRule> = z.object({
  actions: z.array(eventActionSchema),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  description: z.string().optional(),
});

export const r2BucketEventNotificationPropertiesSchema: z.ZodType<R2BucketEventNotificationProperties> =
  z.object({
    bucketName: z.string(),
    queueId: z.string(),
    rules: z.array(ruleSchema),
  });

function normalize(p: R2BucketEventNotificationProperties): unknown {
  return {
    bucketName: p.bucketName,
    queueId: p.queueId,
    rules: p.rules.map((r) => ({
      actions: [...r.actions].sort(),
      ...(r.prefix !== undefined ? { prefix: r.prefix } : {}),
      ...(r.suffix !== undefined ? { suffix: r.suffix } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    })),
  };
}

function splitNativeId(nativeId: string): { bucketName: string; queueId: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed R2BucketEventNotification nativeId: ${nativeId}`);
  return { bucketName: nativeId.slice(0, sep), queueId: nativeId.slice(sep + 2) };
}

export const r2BucketEventNotificationProvider: CloudflareResourceProvider<R2BucketEventNotificationProperties> =
  {
    resourceType: 'R2BucketEventNotification',
    schema: r2BucketEventNotificationPropertiesSchema,
    equals: makeEquals<R2BucketEventNotificationProperties>(normalize),

    async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
      // Event notifications are per (bucket, queue) pair. There's no
      // cluster-wide list, and rate-limiting the per-bucket list across
      // every R2 bucket would be expensive. Drift is caught by read.
    },

    async read(ctx, nativeId) {
      const { bucketName, queueId } = splitNativeId(nativeId);
      try {
        const resp = await ctx.cloudflare.r2.buckets.eventNotifications.get(bucketName, queueId, {
          account_id: ctx.accountId,
        });
        return {
          bucketName,
          queueId,
          rules: (resp.rules ?? []).map((r) => ({
            actions: r.actions,
            ...(r.prefix !== undefined ? { prefix: r.prefix } : {}),
            ...(r.suffix !== undefined ? { suffix: r.suffix } : {}),
            ...(r.description !== undefined ? { description: r.description } : {}),
          })),
        };
      } catch (raw) {
        const err = toProviderError(raw);
        if (err.code === 'NotFound') return NotFound;
        throw err;
      }
    },

    async create(ctx, _label, desired): Promise<CreateResult> {
      await putRules(ctx, desired);
      return {
        kind: 'sync',
        nativeId: `${desired.bucketName}::${desired.queueId}`,
        properties: desired,
      };
    },

    async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
      await putRules(ctx, desired);
      return { kind: 'sync', nativeId, properties: desired };
    },

    async delete(ctx, nativeId): Promise<DeleteResult> {
      const { bucketName, queueId } = splitNativeId(nativeId);
      try {
        await ctx.cloudflare.r2.buckets.eventNotifications.delete(bucketName, queueId, {
          account_id: ctx.accountId,
        });
        return { kind: 'sync' };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },
  };

async function putRules(
  ctx: ProviderContext,
  desired: R2BucketEventNotificationProperties,
): Promise<void> {
  try {
    await ctx.cloudflare.r2.buckets.eventNotifications.update(desired.bucketName, desired.queueId, {
      account_id: ctx.accountId,
      rules: desired.rules.map((r) => ({
        actions: [...r.actions],
        ...(r.prefix !== undefined ? { prefix: r.prefix } : {}),
        ...(r.suffix !== undefined ? { suffix: r.suffix } : {}),
        ...(r.description !== undefined ? { description: r.description } : {}),
      })),
    });
  } catch (raw) {
    throw toProviderError(raw);
  }
}
