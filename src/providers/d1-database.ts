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

export interface D1DatabaseProperties {
  readonly databaseName: string;
  readonly primaryLocationHint?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
}

export const d1DatabasePropsSchema: z.ZodType<D1DatabaseProperties> = z.object({
  databaseName: z.string(),
  primaryLocationHint: z.enum(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']).optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const d1DatabaseProvider: CloudflareResourceProvider<D1DatabaseProperties> = {
  resourceType: 'D1Database',
  schema: d1DatabasePropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.d1.database.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const db of iter) {
        const dbName = (db as { name?: string }).name;
        const dbId = (db as { uuid?: string }).uuid;
        if (!dbName || !dbId) continue;
        const label = parseLabel(dbName);
        if (label === null) continue;
        yield { nativeId: dbId, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const db = await ctx.cloudflare.d1.database.get(nativeId, { account_id: ctx.accountId });
      const d = db as { name?: string };
      if (!d.name) return NotFound;
      // primary_location_hint is set on create and not always returned. Skip on read.
      return { databaseName: d.name };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const db = await ctx.cloudflare.d1.database.create({
        account_id: ctx.accountId,
        name: desired.databaseName,
        ...(desired.primaryLocationHint !== undefined
          ? { primary_location_hint: desired.primaryLocationHint }
          : {}),
      });
      const id = (db as { uuid?: string }).uuid ?? desired.databaseName;
      return {
        kind: 'sync',
        nativeId: id,
        properties: { databaseName: desired.databaseName },
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(_ctx, _nativeId, prior, desired): Promise<UpdateResult> {
    // D1 databases are essentially immutable from k1c's manifest perspective:
    // primary location and name cannot be changed in place, so any property change
    // forces a recreate. The reconciler will surface this to the user.
    if (
      prior.databaseName !== desired.databaseName ||
      prior.primaryLocationHint !== desired.primaryLocationHint
    ) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message: 'D1 database name and primary location are immutable; recreate to change.',
      };
    }
    return { kind: 'noop' };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.d1.database.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
