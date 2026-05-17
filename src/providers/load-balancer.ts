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
 * Cloudflare Load Balancer (zone-scoped top-level). References pool IDs
 * — wire them in via `<resolved-at-apply:LoadBalancerPool:ns/name>` in
 * the `defaultPools` / `fallbackPool` fields.
 *
 * The `name` field is a DNS hostname inside the zone. List() filters by a
 * `k1c:<ns>/<name>` description prefix, which lower sets on the
 * description field.
 */
export type SteeringPolicy =
  | 'off'
  | 'geo'
  | 'random'
  | 'dynamic_latency'
  | 'proximity'
  | 'least_outstanding_requests'
  | 'least_connections';

export interface LoadBalancerProperties {
  readonly zoneId: string;
  /** DNS hostname (apex or subdomain of the zone). */
  readonly name: string;
  /** Pool ids in failover order. */
  readonly defaultPools: ReadonlyArray<string>;
  /** Pool id used when every other pool is unhealthy. */
  readonly fallbackPool: string;
  /** Already prefixed with `k1c:<ns>/<name>` by the lower layer. */
  readonly description: string;
  readonly proxied?: boolean;
  readonly enabled?: boolean;
  readonly ttl?: number;
  readonly steeringPolicy?: SteeringPolicy;
}

export const loadBalancerPropertiesSchema: z.ZodType<LoadBalancerProperties> = z.object({
  zoneId: z.string(),
  name: z.string(),
  defaultPools: z.array(z.string()).min(1),
  fallbackPool: z.string(),
  description: z.string(),
  proxied: z.boolean().optional(),
  enabled: z.boolean().optional(),
  ttl: z.number().int().positive().optional(),
  steeringPolicy: z
    .enum([
      'off',
      'geo',
      'random',
      'dynamic_latency',
      'proximity',
      'least_outstanding_requests',
      'least_connections',
    ])
    .optional(),
});

const DESC_PREFIX = 'k1c:';

function parseDescription(desc: string | undefined): string | null {
  if (typeof desc !== 'string' || !desc.startsWith(DESC_PREFIX)) return null;
  const rest = desc.slice(DESC_PREFIX.length);
  const sep = rest.indexOf(' ');
  const label = sep > 0 ? rest.slice(0, sep) : rest;
  return label.includes('/') ? label : null;
}

function normalize(p: LoadBalancerProperties): unknown {
  return {
    zoneId: p.zoneId,
    name: p.name,
    defaultPools: [...p.defaultPools],
    fallbackPool: p.fallbackPool,
    description: p.description,
    proxied: p.proxied ?? false,
    enabled: p.enabled ?? true,
    ttl: p.ttl ?? 30,
    steeringPolicy: p.steeringPolicy ?? 'off',
  };
}

function toApiBody(p: LoadBalancerProperties): Record<string, unknown> {
  return {
    name: p.name,
    default_pools: [...p.defaultPools],
    fallback_pool: p.fallbackPool,
    description: p.description,
    ...(p.proxied !== undefined ? { proxied: p.proxied } : {}),
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    ...(p.ttl !== undefined ? { ttl: p.ttl } : {}),
    ...(p.steeringPolicy !== undefined ? { steering_policy: p.steeringPolicy } : {}),
  };
}

export const loadBalancerProvider: CloudflareResourceProvider<LoadBalancerProperties> = {
  resourceType: 'LoadBalancer',
  schema: loadBalancerPropertiesSchema,
  equals: makeEquals<LoadBalancerProperties>(normalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    const zoneId = ctx.zoneId;
    if (!zoneId) return;
    try {
      const page = await ctx.cloudflare.loadBalancers.list({ zone_id: zoneId });
      for await (const lb of page) {
        const label = parseDescription((lb as { description?: string }).description);
        if (label === null) continue;
        const id = (lb as { id?: string }).id;
        if (typeof id !== 'string') continue;
        yield { nativeId: id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const found = await findById(ctx, nativeId);
      if (found === null) return NotFound;
      const lb = found.lb as Record<string, unknown>;
      return {
        zoneId: found.zoneId,
        name: (lb['name'] as string) ?? '',
        defaultPools: (lb['default_pools'] as string[] | undefined) ?? [],
        fallbackPool: (lb['fallback_pool'] as string) ?? '',
        description: (lb['description'] as string) ?? '',
        ...(lb['proxied'] !== undefined ? { proxied: lb['proxied'] as boolean } : {}),
        ...(lb['enabled'] !== undefined ? { enabled: lb['enabled'] as boolean } : {}),
        ...(lb['ttl'] !== undefined ? { ttl: lb['ttl'] as number } : {}),
        ...(lb['steering_policy'] !== undefined
          ? { steeringPolicy: lb['steering_policy'] as SteeringPolicy }
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
      const lb = (await ctx.cloudflare.loadBalancers.create({
        zone_id: desired.zoneId,
        ...toApiBody(desired),
      } as never)) as { id?: string };
      const id = lb.id ?? '';
      if (!id) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'LoadBalancer create returned no id',
        };
      }
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.loadBalancers.update(nativeId, {
        zone_id: desired.zoneId,
        ...toApiBody(desired),
      } as never);
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    // delete needs zone_id; walk ctx.zoneId first, otherwise hunt across
    // zones via findById.
    try {
      const zoneId = ctx.zoneId ?? (await findById(ctx, nativeId))?.zoneId;
      if (!zoneId) {
        throw {
          code: 'NotFound' as const,
          recoverable: false,
          message: `LoadBalancer ${nativeId} not found in any accessible zone`,
        };
      }
      await ctx.cloudflare.loadBalancers.delete(nativeId, { zone_id: zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};

async function findById(
  ctx: ProviderContext,
  nativeId: string,
): Promise<{ lb: unknown; zoneId: string } | null> {
  const zoneId = ctx.zoneId;
  if (!zoneId) return null;
  try {
    const lb = await ctx.cloudflare.loadBalancers.get(nativeId, { zone_id: zoneId });
    return { lb, zoneId };
  } catch (raw) {
    const err = toProviderError(raw);
    if (err.code === 'NotFound') return null;
    throw err;
  }
}
