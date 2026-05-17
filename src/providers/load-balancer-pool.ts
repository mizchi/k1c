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
 * Cloudflare Load Balancer pool — a named group of origin servers. The
 * `poolName` is the user-visible handle and must be alphanumeric +
 * hyphen + underscore only; lower prefixes with `k1c-<ns>-<name>` so
 * list() can identify k1c-managed rows.
 *
 * The `monitor` field is a monitor id; tie a LoadBalancerMonitor's
 * nativeId in by hand via `<resolved-at-apply:LoadBalancerMonitor:ns/name>`.
 */
export interface PoolOrigin {
  readonly address: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly weight?: number;
  readonly port?: number;
}

export interface LoadBalancerPoolProperties {
  /** Pool name; must be alphanumeric + `-` + `_` only. */
  readonly poolName: string;
  readonly origins: ReadonlyArray<PoolOrigin>;
  /** Monitor id (from a LoadBalancerMonitor's nativeId). */
  readonly monitor?: string;
  readonly enabled?: boolean;
  readonly minimumOrigins?: number;
  readonly description?: string;
  readonly notificationEmail?: string;
}

const originSchema: z.ZodType<PoolOrigin> = z.object({
  address: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

export const loadBalancerPoolPropertiesSchema: z.ZodType<LoadBalancerPoolProperties> = z.object({
  poolName: z.string().regex(/^[A-Za-z0-9_-]+$/, 'poolName must be alphanumeric + - + _'),
  origins: z.array(originSchema).min(1),
  monitor: z.string().optional(),
  enabled: z.boolean().optional(),
  minimumOrigins: z.number().int().min(0).optional(),
  description: z.string().optional(),
  notificationEmail: z.string().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string | undefined): string | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

function normalize(p: LoadBalancerPoolProperties): unknown {
  return {
    poolName: p.poolName,
    origins: [...p.origins]
      .map((o) => ({
        address: o.address,
        name: o.name ?? '',
        enabled: o.enabled ?? true,
        weight: o.weight ?? 1,
        port: o.port ?? 0,
      }))
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
    monitor: p.monitor ?? '',
    enabled: p.enabled ?? true,
    minimumOrigins: p.minimumOrigins ?? 1,
    description: p.description ?? '',
    notificationEmail: p.notificationEmail ?? '',
  };
}

function toApiBody(p: LoadBalancerPoolProperties): Record<string, unknown> {
  return {
    name: p.poolName,
    origins: p.origins.map((o) => ({
      address: o.address,
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
      ...(o.weight !== undefined ? { weight: o.weight } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
    })),
    ...(p.monitor !== undefined ? { monitor: p.monitor } : {}),
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    ...(p.minimumOrigins !== undefined ? { minimum_origins: p.minimumOrigins } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.notificationEmail !== undefined ? { notification_email: p.notificationEmail } : {}),
  };
}

export const loadBalancerPoolProvider: CloudflareResourceProvider<LoadBalancerPoolProperties> = {
  resourceType: 'LoadBalancerPool',
  schema: loadBalancerPoolPropertiesSchema,
  equals: makeEquals<LoadBalancerPoolProperties>(normalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    try {
      const page = await ctx.cloudflare.loadBalancers.pools.list({ account_id: ctx.accountId });
      for await (const p of page) {
        const label = parseLabel((p as { name?: string }).name);
        if (label === null) continue;
        const id = (p as { id?: string }).id;
        if (typeof id !== 'string') continue;
        yield { nativeId: id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const p = (await ctx.cloudflare.loadBalancers.pools.get(nativeId, {
        account_id: ctx.accountId,
      })) as Record<string, unknown>;
      const originsRaw = (p['origins'] as Array<Record<string, unknown>> | undefined) ?? [];
      const origins: PoolOrigin[] = originsRaw.map((o) => ({
        address: (o['address'] as string) ?? '',
        ...(o['name'] !== undefined ? { name: o['name'] as string } : {}),
        ...(o['enabled'] !== undefined ? { enabled: o['enabled'] as boolean } : {}),
        ...(o['weight'] !== undefined ? { weight: o['weight'] as number } : {}),
        ...(o['port'] !== undefined ? { port: o['port'] as number } : {}),
      }));
      return {
        poolName: (p['name'] as string) ?? '',
        origins,
        ...(p['monitor'] !== undefined ? { monitor: p['monitor'] as string } : {}),
        ...(p['enabled'] !== undefined ? { enabled: p['enabled'] as boolean } : {}),
        ...(p['minimum_origins'] !== undefined
          ? { minimumOrigins: p['minimum_origins'] as number }
          : {}),
        ...(p['description'] !== undefined ? { description: p['description'] as string } : {}),
        ...(p['notification_email'] !== undefined
          ? { notificationEmail: p['notification_email'] as string }
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
      const p = (await ctx.cloudflare.loadBalancers.pools.create({
        account_id: ctx.accountId,
        ...toApiBody(desired),
      } as never)) as { id?: string };
      const id = p.id ?? '';
      if (!id) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'LoadBalancerPool create returned no id',
        };
      }
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.loadBalancers.pools.update(nativeId, {
        account_id: ctx.accountId,
        ...toApiBody(desired),
      } as never);
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.loadBalancers.pools.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
