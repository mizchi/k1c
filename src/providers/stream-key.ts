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
 * Cloudflare Stream signing key (RSA). The Cloudflare API allocates
 * the key pair on create; spec is intentionally empty — there are no
 * tunable knobs. The opaque \`identifier\` becomes the nativeId.
 *
 * Keys are immutable; rotating means deleting + recreating, which
 * invalidates every signed URL produced by the old key.
 *
 * list() is intentionally empty: the keys endpoint has no name /
 * label field, so we cannot tell which key came from k1c. Drift is
 * handled via read on the known nativeId.
 */
export interface StreamKeyProperties {
  /** Future-proof slot; nothing tunable today. */
  readonly placeholder?: never;
}

export const streamKeyPropertiesSchema: z.ZodType<StreamKeyProperties> = z.object({
  placeholder: z.never().optional(),
});

export const streamKeyProvider: CloudflareResourceProvider<StreamKeyProperties> = {
  resourceType: 'StreamKey',
  schema: streamKeyPropertiesSchema,

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // No way to mark a key as k1c-managed on the Cloudflare side.
  },

  async read(ctx, nativeId) {
    try {
      // SDK exposes only a paginated `get` (no per-key endpoint); walk
      // the page and look for a matching id. Treat "not in list" as
      // NotFound so the planner reissues a fresh create.
      const page = await ctx.cloudflare.stream.keys.get({ account_id: ctx.accountId });
      for await (const k of page) {
        if (typeof k.id === 'string' && k.id === nativeId) return {};
      }
      return NotFound;
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, _desired): Promise<CreateResult> {
    try {
      const k = await ctx.cloudflare.stream.keys.create({
        account_id: ctx.accountId,
        body: {},
      });
      const id = k.id ?? '';
      if (!id) throw { code: 'ServiceInternalError' as const, recoverable: false, message: 'Stream key create returned no id' };
      return { kind: 'sync', nativeId: id, properties: {} };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(_ctx, _nativeId, _prior, _desired): Promise<UpdateResult> {
    // Keys are immutable; nothing to update on the spec side.
    return { kind: 'noop' };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.stream.keys.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
