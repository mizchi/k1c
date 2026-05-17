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
 * Cloudflare Load Balancer health-check monitor. Monitors have no name
 * field, so the manifest's ns/name pair is encoded into `description`
 * with a `k1c:<ns>/<name>` prefix (`lower` is responsible for prepending
 * it; the provider just writes the description verbatim and uses the
 * prefix on read to identify k1c-managed rows).
 */
export type MonitorType = 'http' | 'https' | 'tcp' | 'udp_icmp' | 'icmp_ping' | 'smtp';

export interface LoadBalancerMonitorProperties {
  /** Already prefixed with `k1c:<ns>/<name>` by the lower layer. */
  readonly description: string;
  readonly type: MonitorType;
  readonly method?: string;
  readonly path?: string;
  readonly port?: number;
  readonly expectedCodes?: string;
  readonly expectedBody?: string;
  readonly interval?: number;
  readonly timeout?: number;
  readonly retries?: number;
  readonly followRedirects?: boolean;
  readonly allowInsecure?: boolean;
  readonly header?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const loadBalancerMonitorPropertiesSchema: z.ZodType<LoadBalancerMonitorProperties> =
  z.object({
    description: z.string(),
    type: z.enum(['http', 'https', 'tcp', 'udp_icmp', 'icmp_ping', 'smtp']),
    method: z.string().optional(),
    path: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    expectedCodes: z.string().optional(),
    expectedBody: z.string().optional(),
    interval: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    retries: z.number().int().min(0).optional(),
    followRedirects: z.boolean().optional(),
    allowInsecure: z.boolean().optional(),
    header: z.record(z.array(z.string())).optional(),
  });

export const MONITOR_DESC_PREFIX = 'k1c:';

export function parseMonitorDescription(desc: string | undefined): string | null {
  if (typeof desc !== 'string' || !desc.startsWith(MONITOR_DESC_PREFIX)) return null;
  const rest = desc.slice(MONITOR_DESC_PREFIX.length);
  const sep = rest.indexOf(' ');
  const label = sep > 0 ? rest.slice(0, sep) : rest;
  return label.includes('/') ? label : null;
}

function normalize(p: LoadBalancerMonitorProperties): unknown {
  return {
    description: p.description,
    type: p.type,
    method: p.method ?? '',
    path: p.path ?? '',
    port: p.port ?? 0,
    expectedCodes: p.expectedCodes ?? '',
    expectedBody: p.expectedBody ?? '',
    interval: p.interval ?? 60,
    timeout: p.timeout ?? 5,
    retries: p.retries ?? 2,
    followRedirects: p.followRedirects ?? false,
    allowInsecure: p.allowInsecure ?? false,
    header: Object.fromEntries(
      Object.entries(p.header ?? {})
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  };
}

function toApiBody(p: LoadBalancerMonitorProperties): Record<string, unknown> {
  return {
    description: p.description,
    type: p.type,
    ...(p.method !== undefined ? { method: p.method } : {}),
    ...(p.path !== undefined ? { path: p.path } : {}),
    ...(p.port !== undefined ? { port: p.port } : {}),
    ...(p.expectedCodes !== undefined ? { expected_codes: p.expectedCodes } : {}),
    ...(p.expectedBody !== undefined ? { expected_body: p.expectedBody } : {}),
    ...(p.interval !== undefined ? { interval: p.interval } : {}),
    ...(p.timeout !== undefined ? { timeout: p.timeout } : {}),
    ...(p.retries !== undefined ? { retries: p.retries } : {}),
    ...(p.followRedirects !== undefined ? { follow_redirects: p.followRedirects } : {}),
    ...(p.allowInsecure !== undefined ? { allow_insecure: p.allowInsecure } : {}),
    ...(p.header !== undefined
      ? { header: Object.fromEntries(Object.entries(p.header).map(([k, v]) => [k, [...v]])) }
      : {}),
  };
}

export const loadBalancerMonitorProvider: CloudflareResourceProvider<LoadBalancerMonitorProperties> =
  {
    resourceType: 'LoadBalancerMonitor',
    schema: loadBalancerMonitorPropertiesSchema,
    equals: makeEquals<LoadBalancerMonitorProperties>(normalize),

    async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
      try {
        const page = await ctx.cloudflare.loadBalancers.monitors.list({
          account_id: ctx.accountId,
        });
        for await (const m of page) {
          const label = parseMonitorDescription((m as { description?: string }).description);
          if (label === null) continue;
          const id = (m as { id?: string }).id;
          if (typeof id !== 'string') continue;
          yield { nativeId: id, label };
        }
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async read(ctx, nativeId) {
      try {
        const m = (await ctx.cloudflare.loadBalancers.monitors.get(nativeId, {
          account_id: ctx.accountId,
        })) as Record<string, unknown>;
        return {
          description: (m['description'] as string) ?? '',
          type: (m['type'] as MonitorType) ?? 'http',
          ...(m['method'] !== undefined ? { method: m['method'] as string } : {}),
          ...(m['path'] !== undefined ? { path: m['path'] as string } : {}),
          ...(m['port'] !== undefined ? { port: m['port'] as number } : {}),
          ...(m['expected_codes'] !== undefined
            ? { expectedCodes: m['expected_codes'] as string }
            : {}),
          ...(m['expected_body'] !== undefined
            ? { expectedBody: m['expected_body'] as string }
            : {}),
          ...(m['interval'] !== undefined ? { interval: m['interval'] as number } : {}),
          ...(m['timeout'] !== undefined ? { timeout: m['timeout'] as number } : {}),
          ...(m['retries'] !== undefined ? { retries: m['retries'] as number } : {}),
          ...(m['follow_redirects'] !== undefined
            ? { followRedirects: m['follow_redirects'] as boolean }
            : {}),
          ...(m['allow_insecure'] !== undefined
            ? { allowInsecure: m['allow_insecure'] as boolean }
            : {}),
          ...(m['header'] !== undefined
            ? { header: m['header'] as Record<string, string[]> }
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
        const m = (await ctx.cloudflare.loadBalancers.monitors.create({
          account_id: ctx.accountId,
          ...toApiBody(desired),
        } as never)) as { id?: string };
        const id = m.id ?? '';
        if (!id) {
          throw {
            code: 'ServiceInternalError' as const,
            recoverable: false,
            message: 'LoadBalancerMonitor create returned no id',
          };
        }
        return { kind: 'sync', nativeId: id, properties: desired };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
      try {
        await ctx.cloudflare.loadBalancers.monitors.update(nativeId, {
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
        await ctx.cloudflare.loadBalancers.monitors.delete(nativeId, {
          account_id: ctx.accountId,
        });
        return { kind: 'sync' };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },
  };
