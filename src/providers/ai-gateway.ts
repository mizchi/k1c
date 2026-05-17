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

export interface AIGatewayProperties {
  readonly id: string;
  readonly cacheInvalidateOnUpdate: boolean;
  readonly cacheTtl: number | null;
  readonly collectLogs: boolean;
  readonly rateLimiting: {
    readonly interval: number | null;
    readonly limit: number | null;
    readonly technique: 'fixed' | 'sliding';
  };
  readonly authentication?: boolean;
  readonly logManagement?: {
    readonly retention: number | null;
    readonly strategy: 'STOP_INSERTING' | 'DELETE_OLDEST' | null;
  };
  readonly logpush?: {
    readonly enabled: boolean;
    readonly publicKey?: string | null;
  };
}

export const aiGatewaySchema: z.ZodType<AIGatewayProperties> = z.object({
  id: z.string(),
  cacheInvalidateOnUpdate: z.boolean(),
  cacheTtl: z.number().int().nonnegative().nullable(),
  collectLogs: z.boolean(),
  rateLimiting: z.object({
    interval: z.number().int().nonnegative().nullable(),
    limit: z.number().int().nonnegative().nullable(),
    technique: z.enum(['fixed', 'sliding']),
  }),
  authentication: z.boolean().optional(),
  logManagement: z
    .object({
      retention: z.number().int().nonnegative().nullable(),
      strategy: z.enum(['STOP_INSERTING', 'DELETE_OLDEST']).nullable(),
    })
    .optional(),
  logpush: z
    .object({
      enabled: z.boolean(),
      publicKey: z.string().nullable().optional(),
    })
    .optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(id: string): string | null {
  if (!id.startsWith(NAME_PREFIX)) return null;
  const rest = id.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

function buildUpdateBody(props: AIGatewayProperties) {
  return {
    cache_invalidate_on_update: props.cacheInvalidateOnUpdate,
    cache_ttl: props.cacheTtl,
    collect_logs: props.collectLogs,
    rate_limiting_interval: props.rateLimiting.interval,
    rate_limiting_limit: props.rateLimiting.limit,
    rate_limiting_technique: props.rateLimiting.technique,
    ...(props.authentication !== undefined ? { authentication: props.authentication } : {}),
    ...(props.logManagement !== undefined
      ? {
          log_management: props.logManagement.retention,
          log_management_strategy: props.logManagement.strategy,
        }
      : {}),
    ...(props.logpush !== undefined
      ? {
          logpush: props.logpush.enabled,
          ...(props.logpush.publicKey !== undefined
            ? { logpush_public_key: props.logpush.publicKey }
            : {}),
        }
      : {}),
  };
}

function fromResponse(raw: unknown, fallbackId: string): AIGatewayProperties | NotFound {
  const g = raw as {
    id?: string;
    cache_invalidate_on_update?: boolean;
    cache_ttl?: number | null;
    collect_logs?: boolean;
    rate_limiting_interval?: number | null;
    rate_limiting_limit?: number | null;
    rate_limiting_technique?: 'fixed' | 'sliding';
    authentication?: boolean;
    log_management?: number | null;
    log_management_strategy?: 'STOP_INSERTING' | 'DELETE_OLDEST' | null;
    logpush?: boolean;
    logpush_public_key?: string | null;
  };
  const id = g.id ?? fallbackId;
  if (!id) return NotFound;
  return {
    id,
    cacheInvalidateOnUpdate: g.cache_invalidate_on_update ?? false,
    cacheTtl: g.cache_ttl ?? null,
    collectLogs: g.collect_logs ?? true,
    rateLimiting: {
      interval: g.rate_limiting_interval ?? null,
      limit: g.rate_limiting_limit ?? null,
      technique: g.rate_limiting_technique ?? 'fixed',
    },
    ...(g.authentication !== undefined ? { authentication: g.authentication } : {}),
    ...(g.log_management !== undefined || g.log_management_strategy !== undefined
      ? {
          logManagement: {
            retention: g.log_management ?? null,
            strategy: g.log_management_strategy ?? null,
          },
        }
      : {}),
    ...(g.logpush !== undefined
      ? {
          logpush: {
            enabled: g.logpush,
            ...(g.logpush_public_key !== undefined ? { publicKey: g.logpush_public_key } : {}),
          },
        }
      : {}),
  };
}

export const aiGatewayProvider: CloudflareResourceProvider<AIGatewayProperties> = {
  resourceType: 'AIGateway',
  schema: aiGatewaySchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.aiGateway.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const gateway of iter) {
        const id = (gateway as { id?: string }).id;
        if (!id) continue;
        const label = parseLabel(id);
        if (label === null) continue;
        yield { nativeId: id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const gateway = await ctx.cloudflare.aiGateway.get(nativeId, {
        account_id: ctx.accountId,
      });
      return fromResponse(gateway, nativeId);
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const gateway = await ctx.cloudflare.aiGateway.create({
        account_id: ctx.accountId,
        id: desired.id,
        ...buildUpdateBody(desired),
      } as never);
      const id = (gateway as { id?: string }).id ?? desired.id;
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.aiGateway.update(nativeId, {
        account_id: ctx.accountId,
        ...buildUpdateBody(desired),
      } as never);
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.aiGateway.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
