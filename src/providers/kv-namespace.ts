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

export interface KVNamespaceProperties {
  readonly title: string;
}

export const kvNamespaceSchema: z.ZodType<KVNamespaceProperties> = z.object({
  title: z.string(),
});

const TITLE_PREFIX = 'k1c/';

function parseLabel(title: string): string | null {
  if (!title.startsWith(TITLE_PREFIX)) return null;
  const rest = title.slice(TITLE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const namespace = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  return `${namespace}/${name}`;
}

export const kvNamespaceProvider: CloudflareResourceProvider<KVNamespaceProperties> = {
  resourceType: 'KVNamespace',
  schema: kvNamespaceSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.kv.namespaces.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const ns of iter) {
        const label = parseLabel(ns.title);
        if (label === null) continue;
        yield { nativeId: ns.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const ns = await ctx.cloudflare.kv.namespaces.get(nativeId, { account_id: ctx.accountId });
      return { title: ns.title };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const ns = await ctx.cloudflare.kv.namespaces.create({
        account_id: ctx.accountId,
        title: desired.title,
      });
      return { kind: 'sync', nativeId: ns.id, properties: { title: ns.title } };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, prior, desired): Promise<UpdateResult> {
    if (prior.title === desired.title) return { kind: 'noop' };
    try {
      const ns = await ctx.cloudflare.kv.namespaces.update(nativeId, {
        account_id: ctx.accountId,
        title: desired.title,
      });
      return { kind: 'sync', nativeId: ns.id, properties: { title: ns.title } };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.kv.namespaces.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
