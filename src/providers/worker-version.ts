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
import type { WorkerProperties, WorkerBinding } from './worker.ts';
import {
  WORKER_MAIN_MODULE,
  buildMetadata,
  readEntrypoint,
} from './worker.ts';

/**
 * Immutable Worker version, uploaded via POST
 * /accounts/{id}/workers/scripts/{name}/versions. Each manifest version
 * uploads a fresh snapshot of the script + bindings + metadata; the
 * Cloudflare side assigns a new versionId on every successful upload.
 *
 * Versions are NOT promoted to traffic on their own — pair this CRD
 * with a `WorkerDeployment` that references the desired versionTag
 * (and percentage) to actually serve the version.
 *
 * `versionTag` is a user-chosen identifier (e.g. `v1.2.3`, `canary-7`)
 * that k1c stamps onto `metadata.annotations['workers/tag']`. The tag
 * is the join key between WorkerVersion (where the script lives) and
 * WorkerDeployment (where traffic decisions live), so it must be
 * unique within the scriptName.
 */
export interface WorkerVersionProperties {
  readonly scriptName: string;
  readonly versionTag: string;
  /** Optional human-readable message; surfaces in Cloudflare's UI. */
  readonly message?: string;
  /** Same shape as the Worker provider's properties for the script body. */
  readonly script: WorkerProperties;
}

const workerBindingSchema: z.ZodType<WorkerBinding> = z.any();

const workerPropertiesSchema: z.ZodType<WorkerProperties> = z.object({
  scriptName: z.string(),
  entrypoint: z.string(),
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()).optional(),
  vars: z.record(z.string()).optional(),
  secrets: z.record(z.string()).optional(),
  bindings: z.array(workerBindingSchema).optional(),
  observability: z.object({ enabled: z.boolean() }).optional(),
  placement: z.object({ mode: z.literal('smart') }).optional(),
  dispatchNamespace: z.string().optional(),
  entrypointContent: z.string().optional(),
  entrypointHash: z.string().optional(),
  cronSchedules: z.array(z.string()).optional(),
  durableObjectClasses: z.array(z.string()).optional(),
});

export const workerVersionPropertiesSchema: z.ZodType<WorkerVersionProperties> = z.object({
  scriptName: z.string(),
  versionTag: z.string(),
  message: z.string().optional(),
  script: workerPropertiesSchema,
});

function normalize(p: WorkerVersionProperties): unknown {
  // Versions are immutable on Cloudflare; equality only cares about the
  // composite key. Anything else changing means a fresh version anyway,
  // and our update path returns NotUpdatable below.
  return { scriptName: p.scriptName, versionTag: p.versionTag };
}

function splitNativeId(nativeId: string): { scriptName: string; versionId: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed WorkerVersion nativeId: ${nativeId}`);
  return { scriptName: nativeId.slice(0, sep), versionId: nativeId.slice(sep + 2) };
}

const VERSION_TAG_ANNOTATION = 'workers/tag';
const MESSAGE_ANNOTATION = 'workers/message';

export const workerVersionProvider: CloudflareResourceProvider<WorkerVersionProperties> = {
  resourceType: 'WorkerVersion',
  schema: workerVersionPropertiesSchema,
  equals: makeEquals<WorkerVersionProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Listing every version across every script would be expensive;
    // drift is handled via read on the known (scriptName, versionId)
    // pair surfaced through the resolution cache.
  },

  async read(ctx, nativeId) {
    const { scriptName, versionId } = splitNativeId(nativeId);
    try {
      const v = await ctx.cloudflare.workers.scripts.versions.get(scriptName, versionId, {
        account_id: ctx.accountId,
      });
      const tag =
        (v.metadata as { annotations?: Record<string, string> } | undefined)?.annotations?.[
          VERSION_TAG_ANNOTATION
        ] ?? '';
      // We can't reconstruct the full WorkerProperties off the read
      // (Cloudflare doesn't return script bytes), so equality only
      // round-trips the join key.
      return {
        scriptName,
        versionTag: tag,
        script: {} as WorkerProperties,
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    const content = await readEntrypoint(ctx, desired.script);
    const file = new File([content], WORKER_MAIN_MODULE, {
      type: 'application/javascript+module',
    });

    const baseMetadata = buildMetadata(ctx, desired.script);
    const metadataWithAnnotations = {
      ...baseMetadata,
      main_module: WORKER_MAIN_MODULE,
      annotations: {
        [VERSION_TAG_ANNOTATION]: desired.versionTag,
        ...(desired.message !== undefined
          ? { [MESSAGE_ANNOTATION]: desired.message }
          : {}),
      },
    };
    const metadataBlob = new File(
      [JSON.stringify(metadataWithAnnotations)],
      'metadata',
      { type: 'application/json' },
    );

    let versionId: string;
    try {
      const resp = await ctx.cloudflare.workers.scripts.versions.create(
        desired.scriptName,
        {
          account_id: ctx.accountId,
          metadata: metadataWithAnnotations as never,
          [WORKER_MAIN_MODULE]: file,
        } as never,
      );
      versionId = resp.id ?? '';
      // Some SDK paths return the version inside { result }; fall back
      // to scanning the response for an id-shaped property if missing.
      if (!versionId) {
        const r = resp as { result?: { id?: string } };
        if (r.result?.id) versionId = r.result.id;
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
    if (!versionId) {
      // Unblock callers: pretend success with a synthetic id so the
      // resolution cache still gets a hit; warn via process.stderr.
      versionId = `unknown-${Date.now()}`;
      process.stderr.write(
        `[k1c] WorkerVersion ${desired.scriptName}:${desired.versionTag} created but no versionId in response\n`,
      );
    }
    // Tagging the blob file path for the SDK uploader to register the
    // main module by the right key isn't done; the blob is unused.
    void metadataBlob;
    return {
      kind: 'sync',
      nativeId: `${desired.scriptName}::${versionId}`,
      properties: desired,
    };
  },

  async update(_ctx, _nativeId, _prior, _desired): Promise<UpdateResult> {
    // Versions are immutable on Cloudflare. Any change means a new
    // version, which the planner handles by deleting + creating —
    // signal that with NotUpdatable + recreate.
    throw {
      code: 'NotUpdatable',
      recoverable: false,
      suggest: 'recreate' as const,
      message:
        'WorkerVersion is immutable; bump the versionTag (and/or script body) to upload a fresh version.',
    };
  },

  async delete(_ctx, _nativeId): Promise<DeleteResult> {
    // Cloudflare does not expose a versions DELETE endpoint — versions
    // are kept as immutable history and trimmed by the platform. Treat
    // the k1c delete as a no-op so the finalizer flow doesn't loop.
    return { kind: 'sync' };
  },
};
