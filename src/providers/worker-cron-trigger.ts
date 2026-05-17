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
 * Cloudflare-native cron triggers for an existing Worker script. The Worker
 * provider's own `cronSchedules` field already handles cron registration when
 * lowering a k8s CronJob; this CRD is the explicit alternative when the user
 * wants to attach (or remove) cron triggers on a Worker that is deployed
 * outside k1c's lifecycle.
 *
 * Same Worker should NOT be targeted by both paths — last writer wins on the
 * Cloudflare side because the schedules endpoint replaces the full set on
 * every PUT.
 */
export interface WorkerCronTriggerProperties {
  readonly scriptName: string;
  readonly schedules: ReadonlyArray<string>;
}

export const workerCronTriggerPropertiesSchema: z.ZodType<WorkerCronTriggerProperties> = z.object({
  scriptName: z.string(),
  schedules: z.array(z.string()),
});

function normalize(p: WorkerCronTriggerProperties): unknown {
  // Order-insensitive comparison: Cloudflare may reorder the schedule list.
  return {
    scriptName: p.scriptName,
    schedules: [...p.schedules].sort(),
  };
}

export const workerCronTriggerProvider: CloudflareResourceProvider<WorkerCronTriggerProperties> = {
  resourceType: 'WorkerCronTrigger',
  schema: workerCronTriggerPropertiesSchema,
  equals: makeEquals<WorkerCronTriggerProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Cron triggers don't have a dedicated cluster-wide list endpoint and
    // would race with the Worker provider's own cronSchedules path. Skip
    // listing — read+diff on known scriptNames covers drift detection for
    // CRD-managed targets.
  },

  async read(ctx, nativeId) {
    try {
      const resp = await ctx.cloudflare.workers.scripts.schedules.get(nativeId, {
        account_id: ctx.accountId,
      });
      return {
        scriptName: nativeId,
        schedules: (resp.schedules ?? []).map((s) => s.cron),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      await ctx.cloudflare.workers.scripts.schedules.update(desired.scriptName, {
        account_id: ctx.accountId,
        body: desired.schedules.map((cron) => ({ cron })),
      });
      return { kind: 'sync', nativeId: desired.scriptName, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.workers.scripts.schedules.update(nativeId, {
        account_id: ctx.accountId,
        body: desired.schedules.map((cron) => ({ cron })),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    // The schedules endpoint has no DELETE — PUT with an empty body clears
    // every cron trigger on the script.
    try {
      await ctx.cloudflare.workers.scripts.schedules.update(nativeId, {
        account_id: ctx.accountId,
        body: [],
      });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
