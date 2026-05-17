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
 * Traffic-splitting deployment for a Worker. Spec mirrors Cloudflare's
 * `POST /workers/scripts/{name}/deployments`:
 *
 *   strategy: percentage
 *   versions: [{ version_id, percentage }]   // 1 or 2 entries, sum 100
 *
 * Each entry references a Worker version by **versionId** — typically
 * the nativeId stamped by a `WorkerVersion` CRD plus the lookup helper
 * `<resolved-at-apply:WorkerVersion:ns/name>` that the apply-time
 * placeholder resolver substitutes from the resolution cache.
 *
 * Deletion is a no-op: deployments are append-only history on the
 * Cloudflare side. Rolling back means pushing a new deployment that
 * points at the previous version_id, not deleting the latest one.
 */
export interface WorkerDeploymentProperties {
  readonly scriptName: string;
  readonly message?: string;
  readonly versions: ReadonlyArray<{
    readonly versionId: string;
    readonly percentage: number;
  }>;
}

const versionEntrySchema = z.object({
  versionId: z.string(),
  percentage: z.number().min(0).max(100),
});

export const workerDeploymentPropertiesSchema: z.ZodType<WorkerDeploymentProperties> = z.object({
  scriptName: z.string(),
  message: z.string().optional(),
  versions: z.array(versionEntrySchema).min(1).max(2),
});

function normalize(p: WorkerDeploymentProperties): unknown {
  // Order-insensitive comparison so [A=90,B=10] vs [B=10,A=90] are equal.
  const sorted = [...p.versions].sort((a, b) => a.versionId.localeCompare(b.versionId));
  return { scriptName: p.scriptName, versions: sorted };
}

export const workerDeploymentProvider: CloudflareResourceProvider<WorkerDeploymentProperties> = {
  resourceType: 'WorkerDeployment',
  schema: workerDeploymentPropertiesSchema,
  equals: makeEquals<WorkerDeploymentProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // No cluster-wide list — drift handled via read on the known
    // scriptName surfaced through the resolution cache.
  },

  async read(ctx, nativeId) {
    try {
      const resp = await ctx.cloudflare.workers.scripts.deployments.get(nativeId, {
        account_id: ctx.accountId,
      });
      const latest = (resp.deployments ?? [])[0];
      if (!latest) return NotFound;
      return {
        scriptName: nativeId,
        versions: (latest.versions ?? []).map((v) => ({
          versionId: v.version_id,
          percentage: v.percentage,
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
      await ctx.cloudflare.workers.scripts.deployments.create(desired.scriptName, {
        account_id: ctx.accountId,
        strategy: 'percentage',
        versions: desired.versions.map((v) => ({
          version_id: v.versionId,
          percentage: v.percentage,
        })),
        ...(desired.message !== undefined
          ? { annotations: { 'workers/message': desired.message } }
          : {}),
      });
      return { kind: 'sync', nativeId: desired.scriptName, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    // Cloudflare doesn't expose UPDATE for deployments — every change
    // is a fresh POST, which the platform records as a new revision.
    try {
      await ctx.cloudflare.workers.scripts.deployments.create(nativeId, {
        account_id: ctx.accountId,
        strategy: 'percentage',
        versions: desired.versions.map((v) => ({
          version_id: v.versionId,
          percentage: v.percentage,
        })),
        ...(desired.message !== undefined
          ? { annotations: { 'workers/message': desired.message } }
          : {}),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(_ctx, _nativeId): Promise<DeleteResult> {
    // Deployments are an append-only revision log on Cloudflare's side;
    // rolling back means pushing a new deployment, not deleting the
    // latest one. Treat as a no-op so the finalizer flow can clear.
    return { kind: 'sync' };
  },
};
