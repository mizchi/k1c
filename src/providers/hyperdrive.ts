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

export interface HyperdriveProperties {
  readonly name: string;
  readonly origin: {
    readonly scheme: 'postgres' | 'postgresql' | 'mysql';
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    /**
     * Resolved password value, uploaded to Cloudflare on create / update. Cloudflare
     * never returns this on read, so propertiesEqual will mark Hyperdrive as drifted
     * on every apply when this changes; that is acceptable for a write-only field.
     */
    readonly password: string;
  };
  readonly caching?: {
    readonly disabled?: boolean;
    readonly maxAge?: number;
    readonly staleWhileRevalidate?: number;
  };
  readonly originConnectionLimit?: number;
}

export const hyperdriveSchema: z.ZodType<HyperdriveProperties> = z.object({
  name: z.string(),
  origin: z.object({
    scheme: z.enum(['postgres', 'postgresql', 'mysql']),
    host: z.string(),
    port: z.number().int().positive(),
    database: z.string(),
    user: z.string(),
    password: z.string(),
  }),
  caching: z
    .object({
      disabled: z.boolean().optional(),
      maxAge: z.number().int().nonnegative().optional(),
      staleWhileRevalidate: z.number().int().nonnegative().optional(),
    })
    .optional(),
  originConnectionLimit: z.number().int().positive().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

function buildBody(props: HyperdriveProperties) {
  return {
    name: props.name,
    origin: {
      scheme: props.origin.scheme,
      host: props.origin.host,
      port: props.origin.port,
      database: props.origin.database,
      user: props.origin.user,
      password: props.origin.password,
    },
    ...(props.caching !== undefined
      ? {
          caching: {
            ...(props.caching.disabled !== undefined ? { disabled: props.caching.disabled } : {}),
            ...(props.caching.maxAge !== undefined ? { max_age: props.caching.maxAge } : {}),
            ...(props.caching.staleWhileRevalidate !== undefined
              ? { stale_while_revalidate: props.caching.staleWhileRevalidate }
              : {}),
          },
        }
      : {}),
    ...(props.originConnectionLimit !== undefined
      ? { origin_connection_limit: props.originConnectionLimit }
      : {}),
  };
}

/**
 * Drop the password before comparison. Cloudflare's Hyperdrive API
 * never returns it, so read() emits the `<write-only>` sentinel; if
 * we left it in the diff, every apply would think the password
 * changed and trigger an UPDATE. The provider's update() re-uploads
 * the password unconditionally when other fields change, so we don't
 * need to track its drift here.
 */
function hyperdriveEqualsNormalize(p: HyperdriveProperties): unknown {
  return {
    name: p.name,
    origin: {
      scheme: p.origin.scheme,
      host: p.origin.host,
      port: p.origin.port,
      database: p.origin.database,
      user: p.origin.user,
      // password intentionally omitted
    },
    ...(p.caching !== undefined ? { caching: p.caching } : {}),
    ...(p.originConnectionLimit !== undefined
      ? { originConnectionLimit: p.originConnectionLimit }
      : {}),
  };
}

export const hyperdriveProvider: CloudflareResourceProvider<HyperdriveProperties> = {
  resourceType: 'Hyperdrive',
  schema: hyperdriveSchema,
  equals: makeEquals<HyperdriveProperties>(hyperdriveEqualsNormalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.hyperdrive.configs.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const cfg of iter) {
        const cfgName = (cfg as { name?: string }).name;
        const cfgId = (cfg as { id?: string }).id;
        if (!cfgName || !cfgId) continue;
        const label = parseLabel(cfgName);
        if (label === null) continue;
        yield { nativeId: cfgId, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const cfg = await ctx.cloudflare.hyperdrive.configs.get(nativeId, {
        account_id: ctx.accountId,
      });
      const c = cfg as {
        name?: string;
        origin?: {
          scheme?: 'postgres' | 'postgresql' | 'mysql';
          host?: string;
          port?: number;
          database?: string;
          user?: string;
        };
        caching?: { disabled?: boolean; max_age?: number; stale_while_revalidate?: number };
        origin_connection_limit?: number;
      };
      if (!c.name || !c.origin?.scheme || !c.origin?.host || c.origin?.port === undefined) {
        return NotFound;
      }
      return {
        name: c.name,
        origin: {
          scheme: c.origin.scheme,
          host: c.origin.host,
          port: c.origin.port,
          database: c.origin.database ?? '',
          user: c.origin.user ?? '',
          // Cloudflare never returns the password; using a sentinel makes diffs honest:
          // the caller's desired side has a real password, so propertiesEqual will
          // disagree, and update() runs to re-upload the correct password every apply.
          password: '<write-only>',
        },
        ...(c.caching !== undefined
          ? {
              caching: {
                ...(c.caching.disabled !== undefined ? { disabled: c.caching.disabled } : {}),
                ...(c.caching.max_age !== undefined ? { maxAge: c.caching.max_age } : {}),
                ...(c.caching.stale_while_revalidate !== undefined
                  ? { staleWhileRevalidate: c.caching.stale_while_revalidate }
                  : {}),
              },
            }
          : {}),
        ...(c.origin_connection_limit !== undefined
          ? { originConnectionLimit: c.origin_connection_limit }
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
      const cfg = await ctx.cloudflare.hyperdrive.configs.create({
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never);
      const id = (cfg as { id?: string }).id ?? desired.name;
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const cfg = await ctx.cloudflare.hyperdrive.configs.update(nativeId, {
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never);
      const id = (cfg as { id?: string }).id ?? nativeId;
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.hyperdrive.configs.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
