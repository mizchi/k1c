import { z } from 'zod';
import type {
  CloudflareResourceProvider,
  CreateResult,
  DeleteResult,
  ListedResource,
  ProviderContext,
  StatusResult,
  UpdateResult,
} from './types.ts';
import { NotFound } from './types.ts';
import { toProviderError } from './errors.ts';

export type CustomHostnameSslMethod = 'http' | 'cname' | 'txt' | 'email';
export type CustomHostnameSslType = 'dv';

export interface CustomHostnameSsl {
  /** Domain control validation method. Default: `http`. */
  readonly method?: CustomHostnameSslMethod;
  /** Certificate type. Cloudflare's customHostnames API only supports `dv` today. */
  readonly type?: CustomHostnameSslType;
}

export interface CustomHostnameProperties {
  readonly zoneId: string;
  readonly hostname: string;
  readonly ssl?: CustomHostnameSsl;
}

const sslSchema: z.ZodType<CustomHostnameSsl> = z.object({
  method: z.enum(['http', 'cname', 'txt', 'email']).optional(),
  type: z.literal('dv').optional(),
});

export const customHostnamePropertiesSchema: z.ZodType<CustomHostnameProperties> = z.object({
  zoneId: z.string(),
  hostname: z.string(),
  ssl: sslSchema.optional(),
});

const MARKER_KEY = 'k1c.io/managed';

interface CFCustomHostname {
  readonly id?: string;
  readonly hostname?: string;
  readonly status?: string;
  readonly custom_metadata?: Record<string, string>;
  readonly ssl?: { status?: string; method?: string; type?: string };
}

function isManaged(custom: CFCustomHostname): boolean {
  return typeof custom.custom_metadata?.[MARKER_KEY] === 'string';
}

function labelFromMetadata(custom: CFCustomHostname): string | null {
  const v = custom.custom_metadata?.[MARKER_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildBody(props: CustomHostnameProperties, label: string) {
  return {
    zone_id: props.zoneId,
    hostname: props.hostname,
    ...(props.ssl !== undefined
      ? {
          ssl: {
            ...(props.ssl.method !== undefined ? { method: props.ssl.method } : {}),
            ...(props.ssl.type !== undefined ? { type: props.ssl.type } : {}),
          },
        }
      : {}),
    custom_metadata: { [MARKER_KEY]: label },
  };
}

const PENDING_STATES = new Set([
  'pending',
  'pending_blocked',
  'pending_migration',
  'pending_provisioned',
  'pending_deletion',
  'pending_validation',
  'pending_deployment',
  'active_redeploying',
  'test_pending',
  'test_active',
  'test_active_apex',
]);

const FAILURE_STATES = new Set([
  'blocked',
  'pending_blocked',
  'test_blocked',
  'test_failed',
]);

/**
 * Custom Hostnames go through asynchronous SSL provisioning, so the provider
 * returns `kind: 'async'` from create / update and exposes a `status()` method
 * the apply loop polls until the certificate is issued (`hostname.status` ==
 * `active` and `ssl.status` == `active`) or the request is rejected outright
 * (`blocked` / `test_failed`). Pending DCV is reported as `kind: 'pending'`
 * which makes the apply loop sleep and retry.
 *
 * Ownership is tracked via the `custom_metadata` field rather than the rule
 * description — Custom Hostnames have no description field, but they do
 * support arbitrary key/value metadata.
 */
/**
 * Cloudflare's Custom Hostname API populates `ssl` defaults
 * (method: 'http', type: 'dv') when the manifest omits the block.
 * Normalise both sides to the same defaults so a re-apply of an
 * unchanged manifest doesn't flag every hostname as drifting.
 */
function customHostnameEqualsNormalize(p: CustomHostnameProperties): unknown {
  return {
    zoneId: p.zoneId,
    hostname: p.hostname,
    ssl: {
      method: p.ssl?.method ?? 'http',
      type: p.ssl?.type ?? 'dv',
    },
  };
}

function customHostnameStableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export const customHostnameProvider: CloudflareResourceProvider<CustomHostnameProperties> = {
  resourceType: 'CustomHostname',
  schema: customHostnamePropertiesSchema,
  equals(prior, desired) {
    return (
      customHostnameStableStringify(customHostnameEqualsNormalize(prior)) ===
      customHostnameStableStringify(customHostnameEqualsNormalize(desired))
    );
  },

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    let iter;
    try {
      iter = ctx.cloudflare.customHostnames.list({ zone_id: ctx.zoneId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const ch of iter) {
        const c = ch as CFCustomHostname;
        if (!c.id || !isManaged(c)) continue;
        const label = labelFromMetadata(c);
        if (label === null) continue;
        yield { nativeId: c.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    try {
      const ch = (await ctx.cloudflare.customHostnames.get(nativeId, {
        zone_id: ctx.zoneId,
      })) as CFCustomHostname;
      if (!ch.hostname) return NotFound;
      return {
        zoneId: ctx.zoneId,
        hostname: ch.hostname,
        ...(ch.ssl !== undefined
          ? {
              ssl: {
                ...(ch.ssl.method !== undefined ? { method: ch.ssl.method as CustomHostnameSslMethod } : {}),
                ...(ch.ssl.type !== undefined ? { type: ch.ssl.type as CustomHostnameSslType } : {}),
              },
            }
          : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, label, desired): Promise<CreateResult> {
    try {
      const ch = (await ctx.cloudflare.customHostnames.create(
        buildBody(desired, label) as never,
      )) as CFCustomHostname;
      if (!ch.id) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message: 'CustomHostname create: API response missing id',
        };
      }
      return { kind: 'async', nativeId: ch.id, opId: 'provision' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, prior, desired): Promise<UpdateResult> {
    // Cloudflare's customHostnames.edit endpoint can mutate `custom_metadata`
    // and `ssl` in place but cannot rename the hostname itself. Surface the
    // hostname-change case as NotUpdatable so the user opts into the
    // destructive recreate explicitly.
    if (prior.hostname !== desired.hostname) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message: `CustomHostname hostname change (${prior.hostname} → ${desired.hostname}) requires recreate; delete and re-apply`,
      };
    }
    try {
      const body: Record<string, unknown> = {};
      if (desired.ssl !== undefined) {
        body['ssl'] = {
          ...(desired.ssl.method !== undefined ? { method: desired.ssl.method } : {}),
          ...(desired.ssl.type !== undefined ? { type: desired.ssl.type } : {}),
        };
      }
      const ch = (await ctx.cloudflare.customHostnames.edit(nativeId, {
        zone_id: desired.zoneId,
        ...body,
      } as never)) as CFCustomHostname;
      // Re-issuing SSL config returns the hostname to a pending state until
      // CF re-validates; surface as async so the apply loop polls for active.
      return { kind: 'async', nativeId: ch.id ?? nativeId, opId: 'edit' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'CustomHostname delete requires zoneId in ProviderContext',
      };
    }
    try {
      await ctx.cloudflare.customHostnames.delete(nativeId, { zone_id: ctx.zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async status(ctx, nativeId): Promise<StatusResult> {
    if (ctx.zoneId === undefined) {
      return {
        kind: 'failure',
        error: {
          code: 'InvalidRequest',
          recoverable: false,
          message: 'CustomHostname status requires zoneId in ProviderContext',
        },
      };
    }
    try {
      const ch = (await ctx.cloudflare.customHostnames.get(nativeId, {
        zone_id: ctx.zoneId,
      })) as CFCustomHostname;
      const status = ch.status;
      const sslStatus = ch.ssl?.status;
      if (status === 'active' && (sslStatus === undefined || sslStatus === 'active')) {
        return {
          kind: 'success',
          properties: {
            zoneId: ctx.zoneId,
            hostname: ch.hostname ?? '',
          },
        };
      }
      if (status !== undefined && FAILURE_STATES.has(status)) {
        return {
          kind: 'failure',
          error: {
            code: 'NotStabilized',
            recoverable: false,
            message: `CustomHostname ${nativeId} ended in failure state ${status}`,
          },
        };
      }
      // Either explicitly pending or a recognised in-progress status.
      void PENDING_STATES;
      return { kind: 'pending' };
    } catch (raw) {
      const err = toProviderError(raw);
      return { kind: 'failure', error: err };
    }
  },
};
