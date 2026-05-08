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

export interface DispatchNamespaceProperties {
  readonly namespaceName: string;
}

export const dispatchNamespaceSchema: z.ZodType<DispatchNamespaceProperties> = z.object({
  namespaceName: z.string(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const dispatchNamespaceProvider: CloudflareResourceProvider<DispatchNamespaceProperties> =
  {
    resourceType: 'DispatchNamespace',
    schema: dispatchNamespaceSchema,

    async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
      let iter;
      try {
        iter = ctx.cloudflare.workersForPlatforms.dispatch.namespaces.list({
          account_id: ctx.accountId,
        });
      } catch (raw) {
        throw toProviderError(raw);
      }
      try {
        for await (const ns of iter) {
          const name = ns.namespace_name;
          if (!name) continue;
          const label = parseLabel(name);
          if (label === null) continue;
          yield { nativeId: name, label };
        }
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async read(ctx, nativeId) {
      try {
        const ns = await ctx.cloudflare.workersForPlatforms.dispatch.namespaces.get(nativeId, {
          account_id: ctx.accountId,
        });
        return { namespaceName: ns.namespace_name ?? nativeId };
      } catch (raw) {
        const err = toProviderError(raw);
        if (err.code === 'NotFound') return NotFound;
        throw err;
      }
    },

    async create(ctx, _label, desired): Promise<CreateResult> {
      try {
        const ns = await ctx.cloudflare.workersForPlatforms.dispatch.namespaces.create({
          account_id: ctx.accountId,
          name: desired.namespaceName,
        });
        return {
          kind: 'sync',
          nativeId: ns.namespace_name ?? desired.namespaceName,
          properties: { namespaceName: ns.namespace_name ?? desired.namespaceName },
        };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async update(_ctx, _nativeId, prior, desired): Promise<UpdateResult> {
      // Dispatch namespaces are effectively immutable. The only "field" is the name itself,
      // and CF does not support rename. If desired differs from prior, recreate is required.
      if (prior.namespaceName !== desired.namespaceName) {
        throw {
          code: 'NotUpdatable',
          recoverable: false,
          suggest: 'recreate' as const,
          message: 'Dispatch namespace name is immutable; recreate to change.',
        };
      }
      return { kind: 'noop' };
    },

    async delete(ctx, nativeId): Promise<DeleteResult> {
      try {
        await ctx.cloudflare.workersForPlatforms.dispatch.namespaces.delete(nativeId, {
          account_id: ctx.accountId,
        });
        return { kind: 'sync' };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },
  };
