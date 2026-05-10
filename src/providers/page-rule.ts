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
 * Cloudflare Page Rules CRD.
 *
 * Page Rules are Cloudflare's legacy zone-level rules engine. They've
 * been superseded by the Rules engine (Cache Rules / Transform Rules /
 * etc., already shipped here as separate CRDs) but still work for any
 * zone that hasn't migrated.
 *
 * **Ownership caveat**: the API has no `comment` / `name` / `metadata`
 * field, so k1c can't round-trip a `ns/name` label like it does for
 * DNSRecord. We identify rules by `(zoneId, url, priority)`. The user
 * must keep that triple unique across manifests; declaring two
 * PageRule manifests with the same URL+priority in the same zone is
 * the same as declaring two with the same `metadata.name` — it's a
 * collision.
 *
 * This is a documented limitation, not a bug. New deployments should
 * prefer Cache Rules / Transform Rules / Response Header Rules / etc.
 * (under `cloudflare.k1c.io/v1alpha1`) over Page Rules.
 */
export interface PageRuleAction {
  readonly id: string;
  readonly value?: unknown;
}

export interface PageRuleProperties {
  readonly zoneId?: string;
  /** URL match pattern (e.g. `*.example.com/old/*`). */
  readonly url: string;
  readonly status?: 'active' | 'disabled';
  readonly priority?: number;
  readonly actions: ReadonlyArray<PageRuleAction>;
}

export const pageRulePropsSchema: z.ZodType<PageRuleProperties> = z.object({
  zoneId: z.string().optional(),
  url: z.string().min(1),
  status: z.enum(['active', 'disabled']).optional(),
  priority: z.number().int().nonnegative().optional(),
  actions: z.array(
    z.object({
      id: z.string(),
      value: z.unknown().optional(),
    }),
  ),
});

/** Synthesise the matching label from the three identifying fields. */
export function pageRuleLabel(zoneId: string, url: string, priority: number): string {
  return `${zoneId}::${url}::${priority}`;
}

interface CFPageRule {
  readonly id?: string;
  readonly priority?: number;
  readonly status?: 'active' | 'disabled';
  readonly targets?: ReadonlyArray<{
    target?: string;
    constraint?: { operator?: string; value?: string };
  }>;
  readonly actions?: ReadonlyArray<{ id?: string; value?: unknown }>;
}

function urlOf(rule: CFPageRule): string | undefined {
  const t = rule.targets?.[0];
  if (!t || t.target !== 'url') return undefined;
  return t.constraint?.value;
}

function buildBody(props: PageRuleProperties, zoneId: string) {
  return {
    zone_id: zoneId,
    targets: [
      {
        target: 'url' as const,
        constraint: { operator: 'matches' as const, value: props.url },
      },
    ],
    actions: props.actions.map((a) => ({
      id: a.id,
      ...(a.value !== undefined ? { value: a.value } : {}),
    })),
    ...(props.priority !== undefined ? { priority: props.priority } : {}),
    ...(props.status !== undefined ? { status: props.status } : {}),
  };
}

function resolveZoneId(props: PageRuleProperties, ctx: ProviderContext): string | undefined {
  return props.zoneId ?? ctx.zoneId;
}

/**
 * CF returns `status: 'active'` (the default) on every page rule, and
 * the actions array order isn't load-bearing — the rule applies all
 * of them. Normalise both sides to default-active + sort actions by
 * id so a re-apply of an unchanged manifest stays NOOP.
 */
function pageRuleEqualsNormalize(p: PageRuleProperties): unknown {
  return {
    ...(p.zoneId !== undefined ? { zoneId: p.zoneId } : {}),
    url: p.url,
    priority: p.priority ?? 1,
    status: p.status ?? 'active',
    actions: [...p.actions]
      .map((a) => ({ id: a.id, ...(a.value !== undefined ? { value: a.value } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export const pageRuleProvider: CloudflareResourceProvider<PageRuleProperties> = {
  resourceType: 'PageRule',
  schema: pageRulePropsSchema,
  equals: makeEquals<PageRuleProperties>(pageRuleEqualsNormalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    let resp;
    try {
      resp = (await ctx.cloudflare.pageRules.list({ zone_id: ctx.zoneId })) as
        | { result?: ReadonlyArray<CFPageRule> }
        | ReadonlyArray<CFPageRule>;
    } catch (raw) {
      throw toProviderError(raw);
    }
    const items: ReadonlyArray<CFPageRule> = Array.isArray(resp)
      ? resp
      : (resp as { result?: ReadonlyArray<CFPageRule> }).result ?? [];
    for (const r of items) {
      if (!r.id) continue;
      const url = urlOf(r);
      if (url === undefined) continue;
      const priority = r.priority ?? 1;
      yield { nativeId: r.id, label: pageRuleLabel(ctx.zoneId, url, priority) };
    }
  },

  async read(ctx, nativeId) {
    const zoneId = ctx.zoneId;
    if (zoneId === undefined) return NotFound;
    let r: CFPageRule;
    try {
      r = (await ctx.cloudflare.pageRules.get(nativeId, { zone_id: zoneId })) as CFPageRule;
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
    const url = urlOf(r);
    if (!url) return NotFound;
    return {
      zoneId,
      url,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      ...(r.status !== undefined ? { status: r.status } : {}),
      actions: (r.actions ?? []).map((a) => ({
        id: a.id ?? '',
        ...(a.value !== undefined ? { value: a.value } : {}),
      })),
    };
  },

  async create(ctx, _label, properties): Promise<CreateResult> {
    const zoneId = resolveZoneId(properties, ctx);
    if (!zoneId) {
      throw {
        code: 'BadRequest',
        recoverable: false,
        message: 'PageRule.spec.zoneId is required (or provide a zoneId in the apply context)',
      };
    }
    try {
      const body = buildBody(properties, zoneId);
      const created = (await ctx.cloudflare.pageRules.create(
        body as Parameters<typeof ctx.cloudflare.pageRules.create>[0],
      )) as { id?: string };
      if (!created.id) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message: 'PageRule create response did not include an id',
        };
      }
      return { kind: 'sync', nativeId: created.id, properties };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, properties): Promise<UpdateResult> {
    const zoneId = resolveZoneId(properties, ctx);
    if (!zoneId) {
      throw {
        code: 'BadRequest',
        recoverable: false,
        message: 'PageRule.spec.zoneId is required',
      };
    }
    try {
      const body = buildBody(properties, zoneId);
      await ctx.cloudflare.pageRules.update(
        nativeId,
        body as Parameters<typeof ctx.cloudflare.pageRules.update>[1],
      );
      return { kind: 'sync', nativeId, properties };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'BadRequest',
        recoverable: false,
        message: 'cannot delete PageRule: zone id missing in apply context',
      };
    }
    try {
      await ctx.cloudflare.pageRules.delete(nativeId, { zone_id: ctx.zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return { kind: 'sync' };
      throw err;
    }
  },
};
