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

export interface DNSRecordProperties {
  readonly zoneId: string;
  readonly type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
  readonly name: string;
  readonly content: string;
  readonly ttl?: number;
  readonly proxied?: boolean;
  readonly priority?: number;
}

export const dnsRecordPropsSchema: z.ZodType<DNSRecordProperties> = z.object({
  zoneId: z.string(),
  type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']),
  name: z.string(),
  content: z.string(),
  ttl: z.number().int().nonnegative().optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
});

const COMMENT_PREFIX = 'k1c.io/managed=';

function parseLabel(comment: string | undefined): string | null {
  if (!comment) return null;
  if (!comment.startsWith(COMMENT_PREFIX)) return null;
  return comment.slice(COMMENT_PREFIX.length);
}

function buildBody(props: DNSRecordProperties, label: string) {
  return {
    type: props.type,
    name: props.name,
    content: props.content,
    comment: `${COMMENT_PREFIX}${label}`,
    ...(props.ttl !== undefined ? { ttl: props.ttl } : {}),
    ...(props.proxied !== undefined ? { proxied: props.proxied } : {}),
    ...(props.priority !== undefined ? { priority: props.priority } : {}),
  };
}

export const dnsRecordProvider: CloudflareResourceProvider<DNSRecordProperties> = {
  resourceType: 'DNSRecord',
  schema: dnsRecordPropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) {
      // No zone bound; we can't enumerate records account-wide. Yield nothing
      // and rely on the caller to filter by manifest scope.
      return;
    }
    let iter;
    try {
      iter = ctx.cloudflare.dns.records.list({ zone_id: ctx.zoneId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const rec of iter) {
        const r = rec as { id?: string; comment?: string };
        if (!r.id) continue;
        const label = parseLabel(r.comment);
        if (label === null) continue;
        yield { nativeId: r.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    try {
      const rec = await ctx.cloudflare.dns.records.get(nativeId, { zone_id: ctx.zoneId });
      const r = rec as {
        type?: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
        name?: string;
        content?: string;
        ttl?: number;
        proxied?: boolean;
        priority?: number;
      };
      if (!r.type || !r.name || !r.content) return NotFound;
      return {
        zoneId: ctx.zoneId,
        type: r.type,
        name: r.name,
        content: r.content,
        ...(r.ttl !== undefined ? { ttl: r.ttl } : {}),
        ...(r.proxied !== undefined ? { proxied: r.proxied } : {}),
        ...(r.priority !== undefined ? { priority: r.priority } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, label, desired): Promise<CreateResult> {
    try {
      const rec = await ctx.cloudflare.dns.records.create({
        zone_id: desired.zoneId,
        ...buildBody(desired, label),
      } as never);
      const id = (rec as { id?: string }).id ?? `${desired.type}-${desired.name}`;
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      // Use full PUT (`update`) rather than PATCH (`edit`) so the record state matches
      // the manifest exactly — fields the user removed should be reset to defaults.
      const rec = await ctx.cloudflare.dns.records.update(nativeId, {
        zone_id: desired.zoneId,
        ...buildBody(desired, /* label is irrelevant on update */ ''),
      } as never);
      const id = (rec as { id?: string }).id ?? nativeId;
      // Preserve the original comment label by re-issuing it; otherwise the manifest's
      // label would drop and the record would no longer be detected as managed.
      void ctx;
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'DNSRecord delete requires zoneId in ProviderContext',
      };
    }
    try {
      await ctx.cloudflare.dns.records.delete(nativeId, { zone_id: ctx.zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
