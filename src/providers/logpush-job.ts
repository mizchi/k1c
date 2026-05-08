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

export interface LogpushJobProperties {
  readonly jobName: string;
  readonly scope: { readonly zoneId: string } | { readonly accountId: string };
  readonly dataset: string;
  readonly destinationConf: string;
  readonly enabled?: boolean;
  readonly filter?: string;
}

export const logpushJobPropsSchema: z.ZodType<LogpushJobProperties> = z.object({
  jobName: z.string(),
  scope: z.union([
    z.object({ zoneId: z.string() }),
    z.object({ accountId: z.string() }),
  ]),
  dataset: z.string(),
  destinationConf: z.string(),
  enabled: z.boolean().optional(),
  filter: z.string().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

function scopeParams(scope: LogpushJobProperties['scope']): { account_id?: string; zone_id?: string } {
  return 'zoneId' in scope
    ? { zone_id: scope.zoneId }
    : { account_id: scope.accountId };
}

export const logpushJobProvider: CloudflareResourceProvider<LogpushJobProperties> = {
  resourceType: 'LogpushJob',
  schema: logpushJobPropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    // List by zone (if ctx has a zoneId) and / or by account.
    const seen = new Set<number>();
    const params: { account_id?: string; zone_id?: string }[] = [
      { account_id: ctx.accountId },
    ];
    if (ctx.zoneId !== undefined) params.push({ zone_id: ctx.zoneId });
    for (const p of params) {
      let iter;
      try {
        iter = ctx.cloudflare.logpush.jobs.list(p as never);
      } catch (raw) {
        throw toProviderError(raw);
      }
      try {
        for await (const job of iter) {
          if (job === null) continue;
          const j = job as { id?: number; name?: string };
          if (j.id === undefined || seen.has(j.id)) continue;
          seen.add(j.id);
          if (!j.name) continue;
          const label = parseLabel(j.name);
          if (label === null) continue;
          yield { nativeId: String(j.id), label };
        }
      } catch (raw) {
        throw toProviderError(raw);
      }
    }
  },

  async read(ctx, nativeId) {
    const id = Number(nativeId);
    if (Number.isNaN(id)) return NotFound;
    // Try account scope first; fall back to zone scope if ctx has one. Logpush jobs
    // are addressable by id under the scope they were created in, so we probe both.
    const scopes: { account_id?: string; zone_id?: string }[] = [
      { account_id: ctx.accountId },
    ];
    if (ctx.zoneId !== undefined) scopes.push({ zone_id: ctx.zoneId });
    for (const scope of scopes) {
      try {
        const job = await ctx.cloudflare.logpush.jobs.get(id, scope as never);
        if (job === null) continue;
        const j = job as {
          name?: string;
          dataset?: string;
          destination_conf?: string;
          enabled?: boolean;
          filter?: string;
        };
        if (!j.name || !j.dataset || !j.destination_conf) continue;
        const propsScope: LogpushJobProperties['scope'] =
          scope.zone_id !== undefined
            ? { zoneId: scope.zone_id }
            : { accountId: scope.account_id! };
        return {
          jobName: j.name,
          scope: propsScope,
          dataset: j.dataset,
          destinationConf: j.destination_conf,
          ...(j.enabled !== undefined ? { enabled: j.enabled } : {}),
          ...(j.filter !== undefined ? { filter: j.filter } : {}),
        };
      } catch (raw) {
        const err = toProviderError(raw);
        if (err.code === 'NotFound') continue;
        throw err;
      }
    }
    return NotFound;
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const job = await ctx.cloudflare.logpush.jobs.create({
        ...scopeParams(desired.scope),
        name: desired.jobName,
        dataset: desired.dataset,
        destination_conf: desired.destinationConf,
        ...(desired.enabled !== undefined ? { enabled: desired.enabled } : {}),
        ...(desired.filter !== undefined ? { filter: desired.filter } : {}),
      } as never);
      const id = (job as { id?: number } | null)?.id;
      if (id === undefined) throw new Error('logpush.jobs.create returned no id');
      return { kind: 'sync', nativeId: String(id), properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    const id = Number(nativeId);
    if (Number.isNaN(id)) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: `logpushJob.update: nativeId "${nativeId}" is not a numeric job id`,
      };
    }
    try {
      await ctx.cloudflare.logpush.jobs.update(id, {
        ...scopeParams(desired.scope),
        destination_conf: desired.destinationConf,
        ...(desired.enabled !== undefined ? { enabled: desired.enabled } : {}),
        ...(desired.filter !== undefined ? { filter: desired.filter } : {}),
      } as never);
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    const id = Number(nativeId);
    if (Number.isNaN(id)) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: `logpushJob.delete: nativeId "${nativeId}" is not a numeric job id`,
      };
    }
    const scopes: { account_id?: string; zone_id?: string }[] = [
      { account_id: ctx.accountId },
    ];
    if (ctx.zoneId !== undefined) scopes.push({ zone_id: ctx.zoneId });
    let lastErr: unknown;
    for (const scope of scopes) {
      try {
        await ctx.cloudflare.logpush.jobs.delete(id, scope as never);
        return { kind: 'sync' };
      } catch (raw) {
        const err = toProviderError(raw);
        if (err.code !== 'NotFound') throw err;
        lastErr = raw;
      }
    }
    throw toProviderError(lastErr);
  },
};
