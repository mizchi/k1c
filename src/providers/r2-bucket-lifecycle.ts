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

export type R2LifecycleAgeCondition = { readonly type: 'Age'; readonly maxAge: number };
export type R2LifecycleDateCondition = { readonly type: 'Date'; readonly date: string };

export interface R2LifecycleRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly conditions: { readonly prefix: string };
  readonly abortMultipartUploadsTransition?: { readonly condition?: R2LifecycleAgeCondition };
  readonly deleteObjectsTransition?: {
    readonly condition?: R2LifecycleAgeCondition | R2LifecycleDateCondition;
  };
  readonly storageClassTransitions?: ReadonlyArray<{
    readonly condition: R2LifecycleAgeCondition | R2LifecycleDateCondition;
    readonly storageClass: 'InfrequentAccess';
  }>;
}

export interface R2BucketLifecycleProperties {
  readonly bucketName: string;
  readonly rules: ReadonlyArray<R2LifecycleRule>;
}

const ageConditionSchema: z.ZodType<R2LifecycleAgeCondition> = z.object({
  type: z.literal('Age'),
  maxAge: z.number().int().nonnegative(),
});
const dateConditionSchema: z.ZodType<R2LifecycleDateCondition> = z.object({
  type: z.literal('Date'),
  date: z.string(),
});
const lifecycleRuleSchema: z.ZodType<R2LifecycleRule> = z.object({
  id: z.string(),
  enabled: z.boolean(),
  conditions: z.object({ prefix: z.string() }),
  abortMultipartUploadsTransition: z
    .object({ condition: ageConditionSchema.optional() })
    .optional(),
  deleteObjectsTransition: z
    .object({ condition: z.union([ageConditionSchema, dateConditionSchema]).optional() })
    .optional(),
  storageClassTransitions: z
    .array(
      z.object({
        condition: z.union([ageConditionSchema, dateConditionSchema]),
        storageClass: z.literal('InfrequentAccess'),
      }),
    )
    .optional(),
});

export const r2BucketLifecyclePropertiesSchema: z.ZodType<R2BucketLifecycleProperties> = z.object({
  bucketName: z.string(),
  rules: z.array(lifecycleRuleSchema),
});

function normalize(p: R2BucketLifecycleProperties): unknown {
  // Cloudflare returns rules in registration order; manifest order matters
  // for the user, so we keep it as-is but sort transitions deterministically.
  return p;
}

export const r2BucketLifecycleProvider: CloudflareResourceProvider<R2BucketLifecycleProperties> = {
  resourceType: 'R2BucketLifecycle',
  schema: r2BucketLifecyclePropertiesSchema,
  equals: makeEquals<R2BucketLifecycleProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Lifecycle config is per-bucket and there is no cluster-wide list;
    // drift is caught by read on the known bucketName.
  },

  async read(ctx, nativeId) {
    try {
      const resp = await ctx.cloudflare.r2.buckets.lifecycle.get(nativeId, {
        account_id: ctx.accountId,
      });
      return {
        bucketName: nativeId,
        rules: (resp.rules ?? []).map((r) => ({
          id: r.id,
          enabled: r.enabled,
          conditions: { prefix: r.conditions.prefix },
          ...(r.abortMultipartUploadsTransition
            ? { abortMultipartUploadsTransition: r.abortMultipartUploadsTransition }
            : {}),
          ...(r.deleteObjectsTransition
            ? { deleteObjectsTransition: r.deleteObjectsTransition }
            : {}),
          ...(r.storageClassTransitions
            ? { storageClassTransitions: r.storageClassTransitions }
            : {}),
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
    return { kind: 'sync', nativeId: desired.bucketName, properties: desired };
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    await putRules(ctx, { ...desired, bucketName: nativeId });
    return { kind: 'sync', nativeId, properties: desired };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    // No DELETE endpoint — PUT an empty rule list to clear lifecycle.
    await putRules(ctx, { bucketName: nativeId, rules: [] });
    return { kind: 'sync' };
  },
};

async function putRules(ctx: ProviderContext, desired: R2BucketLifecycleProperties): Promise<void> {
  try {
    await ctx.cloudflare.r2.buckets.lifecycle.update(desired.bucketName, {
      account_id: ctx.accountId,
      rules: desired.rules.map((r) => ({
        id: r.id,
        enabled: r.enabled,
        conditions: { prefix: r.conditions.prefix },
        ...(r.abortMultipartUploadsTransition
          ? { abortMultipartUploadsTransition: r.abortMultipartUploadsTransition }
          : {}),
        ...(r.deleteObjectsTransition
          ? { deleteObjectsTransition: r.deleteObjectsTransition }
          : {}),
        ...(r.storageClassTransitions
          ? {
              storageClassTransitions: r.storageClassTransitions.map((t) => ({
                condition: t.condition,
                storageClass: t.storageClass,
              })),
            }
          : {}),
      })),
    });
  } catch (raw) {
    throw toProviderError(raw);
  }
}
