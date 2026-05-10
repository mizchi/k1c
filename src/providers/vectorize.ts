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

export interface VectorizeProperties {
  readonly indexName: string;
  readonly dimensions: number;
  readonly metric: 'cosine' | 'euclidean' | 'dot-product';
  readonly description?: string;
}

export const vectorizePropsSchema: z.ZodType<VectorizeProperties> = z.object({
  indexName: z.string(),
  dimensions: z.number().int().positive(),
  metric: z.enum(['cosine', 'euclidean', 'dot-product']),
  description: z.string().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const vectorizeProvider: CloudflareResourceProvider<VectorizeProperties> = {
  resourceType: 'Vectorize',
  schema: vectorizePropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.vectorize.indexes.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const idx of iter) {
        const name = (idx as { name?: string }).name;
        if (!name) continue;
        const label = parseLabel(name);
        if (label === null) continue;
        // Vectorize uses the index name as its identifier; no separate UUID.
        yield { nativeId: name, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const idx = await ctx.cloudflare.vectorize.indexes.get(nativeId, {
        account_id: ctx.accountId,
      });
      if (idx === null) return NotFound;
      const i = idx as {
        name?: string;
        description?: string;
        config?: { dimensions?: number; metric?: 'cosine' | 'euclidean' | 'dot-product' };
      };
      if (!i.name || !i.config?.dimensions || !i.config?.metric) return NotFound;
      return {
        indexName: i.name,
        dimensions: i.config.dimensions,
        metric: i.config.metric,
        // CF returns description: "" even when the user never set one.
        // Treat empty == absent so re-apply doesn't flag drift.
        ...(i.description !== undefined && i.description !== ''
          ? { description: i.description }
          : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const idx = await ctx.cloudflare.vectorize.indexes.create({
        account_id: ctx.accountId,
        name: desired.indexName,
        config: { dimensions: desired.dimensions, metric: desired.metric },
        ...(desired.description !== undefined ? { description: desired.description } : {}),
      });
      const name = (idx as { name?: string } | null)?.name ?? desired.indexName;
      return { kind: 'sync', nativeId: name, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(_ctx, _nativeId, prior, desired): Promise<UpdateResult> {
    // Vectorize indexes are immutable: dimensions, metric, and name cannot be changed.
    if (
      prior.indexName !== desired.indexName ||
      prior.dimensions !== desired.dimensions ||
      prior.metric !== desired.metric
    ) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message:
          'Vectorize index name / dimensions / metric are immutable; recreate to change.',
      };
    }
    return { kind: 'noop' };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.vectorize.indexes.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
