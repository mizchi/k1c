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

/**
 * Cloudflare Stream Live Input.
 *
 * A long-lived RTMPS / SRT ingest endpoint with a configurable
 * recording policy. Live Inputs are perfect for IaC because they're
 * declarative + persistent (vs uploaded videos, which are one-shot
 * binary blobs).
 *
 * Ownership is tracked in the `meta` field, which Cloudflare exposes
 * as a free-form key-value store on every Live Input. We stamp
 * `meta['k1c.io/managed'] = "<ns>/<name>"` on create and round-trip it
 * back through list().
 */

export type RecordingMode = 'off' | 'automatic';

export interface LiveInputRecording {
  readonly mode?: RecordingMode;
  readonly requireSignedURLs?: boolean;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly hideLiveViewerCount?: boolean;
  readonly timeoutSeconds?: number;
}

export interface StreamLiveInputProperties {
  readonly defaultCreator?: string;
  readonly deleteRecordingAfterDays?: number;
  readonly recording?: LiveInputRecording;
  /**
   * Free-form metadata. The k1c ownership marker
   * (`k1c.io/managed=<ns>/<name>`) is added on top, but anything else
   * the user wants to track survives round-trips.
   */
  readonly meta?: Readonly<Record<string, string>>;
}

const recordingSchema = z.object({
  mode: z.enum(['off', 'automatic']).optional(),
  requireSignedURLs: z.boolean().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  hideLiveViewerCount: z.boolean().optional(),
  timeoutSeconds: z.number().int().nonnegative().optional(),
});

export const streamLiveInputPropsSchema: z.ZodType<StreamLiveInputProperties> = z.object({
  defaultCreator: z.string().optional(),
  deleteRecordingAfterDays: z.number().int().nonnegative().optional(),
  recording: recordingSchema.optional(),
  meta: z.record(z.string()).optional(),
});

const OWNERSHIP_KEY = 'k1c.io/managed';

interface CFLiveInput {
  readonly uid?: string;
  readonly meta?: unknown;
  readonly recording?: LiveInputRecording;
  readonly defaultCreator?: string;
  readonly deleteRecordingAfterDays?: number;
}

function parseLabelFromMeta(meta: unknown): string | null {
  if (meta === null || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const v = m[OWNERSHIP_KEY];
  return typeof v === 'string' ? v : null;
}

function buildMeta(label: string, userMeta?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...(userMeta ?? {}), [OWNERSHIP_KEY]: label };
}

function buildBody(
  props: StreamLiveInputProperties,
  label: string,
  accountId: string,
): Record<string, unknown> {
  return {
    account_id: accountId,
    meta: buildMeta(label, props.meta),
    ...(props.defaultCreator !== undefined ? { defaultCreator: props.defaultCreator } : {}),
    ...(props.deleteRecordingAfterDays !== undefined
      ? { deleteRecordingAfterDays: props.deleteRecordingAfterDays }
      : {}),
    ...(props.recording !== undefined ? { recording: props.recording } : {}),
  };
}

export const streamLiveInputProvider: CloudflareResourceProvider<StreamLiveInputProperties> = {
  resourceType: 'StreamLiveInput',
  schema: streamLiveInputPropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let resp;
    try {
      resp = (await ctx.cloudflare.stream.liveInputs.list({ account_id: ctx.accountId })) as
        | { liveInputs?: ReadonlyArray<CFLiveInput> }
        | { result?: { liveInputs?: ReadonlyArray<CFLiveInput> } };
    } catch (raw) {
      throw toProviderError(raw);
    }
    const items: ReadonlyArray<CFLiveInput> =
      (resp as { liveInputs?: ReadonlyArray<CFLiveInput> }).liveInputs ??
      (resp as { result?: { liveInputs?: ReadonlyArray<CFLiveInput> } }).result?.liveInputs ??
      [];
    for (const li of items) {
      if (!li.uid) continue;
      const label = parseLabelFromMeta(li.meta);
      if (label === null) continue;
      yield { nativeId: li.uid, label };
    }
  },

  async read(ctx, nativeId) {
    let li: CFLiveInput;
    try {
      li = (await ctx.cloudflare.stream.liveInputs.get(nativeId, {
        account_id: ctx.accountId,
      })) as CFLiveInput;
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
    if (!li.uid) return NotFound;
    const meta = (li.meta && typeof li.meta === 'object'
      ? (li.meta as Record<string, string>)
      : {}) as Record<string, string>;
    // Strip our ownership marker so diff() doesn't see it as a change
    // the user introduced.
    const userMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k !== OWNERSHIP_KEY && typeof v === 'string') userMeta[k] = v;
    }
    const out: StreamLiveInputProperties = {
      ...(li.defaultCreator !== undefined ? { defaultCreator: li.defaultCreator } : {}),
      ...(li.deleteRecordingAfterDays !== undefined
        ? { deleteRecordingAfterDays: li.deleteRecordingAfterDays }
        : {}),
      ...(li.recording !== undefined ? { recording: li.recording } : {}),
      ...(Object.keys(userMeta).length > 0 ? { meta: userMeta } : {}),
    };
    return out;
  },

  async create(ctx, label, properties): Promise<CreateResult> {
    try {
      const body = buildBody(properties, label, ctx.accountId);
      const created = (await ctx.cloudflare.stream.liveInputs.create(
        body as unknown as Parameters<typeof ctx.cloudflare.stream.liveInputs.create>[0],
      )) as CFLiveInput;
      if (!created.uid) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message: 'StreamLiveInput create response did not include a uid',
        };
      }
      return { kind: 'sync', nativeId: created.uid, properties };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, properties): Promise<UpdateResult> {
    try {
      // Recover the original label from the API so we don't lose the
      // ownership marker on update.
      const existing = (await ctx.cloudflare.stream.liveInputs.get(nativeId, {
        account_id: ctx.accountId,
      })) as CFLiveInput;
      const existingLabel = parseLabelFromMeta(existing.meta) ?? '';
      const body = buildBody(properties, existingLabel, ctx.accountId);
      await ctx.cloudflare.stream.liveInputs.update(
        nativeId,
        body as unknown as Parameters<typeof ctx.cloudflare.stream.liveInputs.update>[1],
      );
      return { kind: 'sync', nativeId, properties };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.stream.liveInputs.delete(nativeId, {
        account_id: ctx.accountId,
      });
      return { kind: 'sync' };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return { kind: 'sync' };
      throw err;
    }
  },
};
