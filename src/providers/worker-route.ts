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

export interface WorkerRouteProperties {
  readonly zoneId: string;
  readonly pattern: string;
  readonly scriptName: string;
}

export const workerRouteSchema: z.ZodType<WorkerRouteProperties> = z.object({
  zoneId: z.string(),
  pattern: z.string(),
  scriptName: z.string(),
});

const SCRIPT_PREFIX = 'k1c--';

/**
 * Cloudflare Workers Routes carry no per-route comment field, so ownership is
 * inferred from the bound `script` starting with the k1c naming prefix. This
 * is the same approach used by the CustomDomain provider.
 */
function isManaged(script: string | undefined | null): boolean {
  return typeof script === 'string' && script.startsWith(SCRIPT_PREFIX);
}

/**
 * Routes are keyed on `pattern` for the purpose of label matching — the SDK
 * surface lets us list by zone, and within a zone the pattern is unique.
 */
function labelFromPattern(pattern: string | undefined | null): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  return pattern;
}

export const workerRouteProvider: CloudflareResourceProvider<WorkerRouteProperties> = {
  resourceType: 'WorkerRoute',
  schema: workerRouteSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) {
      // Routes are zone-scoped; without a zone we cannot enumerate. Yield nothing.
      return;
    }
    let iter;
    try {
      iter = ctx.cloudflare.workers.routes.list({ zone_id: ctx.zoneId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const r of iter) {
        if (!isManaged(r.script)) continue;
        const label = labelFromPattern(r.pattern);
        if (label === null || !r.id) continue;
        yield { nativeId: r.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    try {
      const r = await ctx.cloudflare.workers.routes.get(nativeId, { zone_id: ctx.zoneId });
      if (!r.pattern || !r.script) return NotFound;
      return { zoneId: ctx.zoneId, pattern: r.pattern, scriptName: r.script };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(_ctx, _label, desired): Promise<CreateResult> {
    try {
      const r = await _ctx.cloudflare.workers.routes.create({
        zone_id: desired.zoneId,
        pattern: desired.pattern,
        script: desired.scriptName,
      });
      return { kind: 'sync', nativeId: r.id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const r = await ctx.cloudflare.workers.routes.update(nativeId, {
        zone_id: desired.zoneId,
        pattern: desired.pattern,
        script: desired.scriptName,
      });
      return { kind: 'sync', nativeId: r.id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'WorkerRoute delete requires zoneId in ProviderContext',
      };
    }
    try {
      await ctx.cloudflare.workers.routes.delete(nativeId, { zone_id: ctx.zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
