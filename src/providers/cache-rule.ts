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

export type CacheRuleTtlMode = 'respect_origin' | 'bypass_by_default' | 'override_origin';

export interface CacheRuleTtl {
  readonly mode: CacheRuleTtlMode;
  readonly default?: number;
}

export interface CacheRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly cache: boolean;
  readonly enabled: boolean;
  readonly edgeTtl?: CacheRuleTtl;
  readonly browserTtl?: CacheRuleTtl;
  readonly description?: string;
}

const ttlSchema = z.object({
  mode: z.enum(['respect_origin', 'bypass_by_default', 'override_origin']),
  default: z.number().int().nonnegative().optional(),
});

export const cacheRulePropertiesSchema: z.ZodType<CacheRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  cache: z.boolean(),
  enabled: z.boolean(),
  edgeTtl: ttlSchema.optional(),
  browserTtl: ttlSchema.optional(),
  description: z.string().optional(),
});

const PHASE = 'http_request_cache_settings' as const;
const MARKER_PREFIX = 'k1c.io/managed=';

interface CFCacheActionParameters {
  readonly cache?: boolean;
  readonly edge_ttl?: { mode: CacheRuleTtlMode; default?: number };
  readonly browser_ttl?: { mode: CacheRuleTtlMode; default?: number };
}

interface CFRule {
  readonly id?: string;
  readonly action?: string;
  readonly action_parameters?: CFCacheActionParameters;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly expression?: string;
}

interface CFRuleset {
  readonly id?: string;
  readonly rules?: ReadonlyArray<CFRule>;
}

function buildDescription(label: string, userDescription: string | undefined): string {
  if (userDescription === undefined || userDescription.length === 0) {
    return `${MARKER_PREFIX}${label}`;
  }
  return `${MARKER_PREFIX}${label}: ${userDescription}`;
}

interface ParsedDescription {
  readonly label: string;
  readonly userDescription?: string;
}

function parseDescription(description: string | undefined): ParsedDescription | null {
  if (!description?.startsWith(MARKER_PREFIX)) return null;
  const rest = description.slice(MARKER_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return { label: rest.trim() };
  const label = rest.slice(0, colon).trim();
  const userDesc = rest.slice(colon + 1).trim();
  return userDesc.length > 0 ? { label, userDescription: userDesc } : { label };
}

function ruleFromProps(props: CacheRuleProperties, label: string, id?: string): CFRule {
  const actionParameters: Record<string, unknown> = { cache: props.cache };
  if (props.edgeTtl !== undefined) {
    actionParameters['edge_ttl'] = {
      mode: props.edgeTtl.mode,
      ...(props.edgeTtl.default !== undefined ? { default: props.edgeTtl.default } : {}),
    };
  }
  if (props.browserTtl !== undefined) {
    actionParameters['browser_ttl'] = {
      mode: props.browserTtl.mode,
      ...(props.browserTtl.default !== undefined ? { default: props.browserTtl.default } : {}),
    };
  }
  return {
    ...(id !== undefined ? { id } : {}),
    action: 'set_cache_settings',
    action_parameters: actionParameters as CFCacheActionParameters,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): CacheRuleProperties | null {
  if (!rule.expression || rule.action !== 'set_cache_settings') return null;
  const ap = rule.action_parameters ?? {};
  const parsed = parseDescription(rule.description);
  return {
    zoneId,
    expression: rule.expression,
    cache: ap.cache ?? false,
    enabled: rule.enabled ?? true,
    ...(ap.edge_ttl !== undefined
      ? {
          edgeTtl: {
            mode: ap.edge_ttl.mode,
            ...(ap.edge_ttl.default !== undefined ? { default: ap.edge_ttl.default } : {}),
          },
        }
      : {}),
    ...(ap.browser_ttl !== undefined
      ? {
          browserTtl: {
            mode: ap.browser_ttl.mode,
            ...(ap.browser_ttl.default !== undefined ? { default: ap.browser_ttl.default } : {}),
          },
        }
      : {}),
    ...(parsed?.userDescription !== undefined
      ? { description: parsed.userDescription }
      : {}),
  };
}

async function getPhaseRules(ctx: ProviderContext, zoneId: string): Promise<CFRule[]> {
  try {
    const rs = (await ctx.cloudflare.rulesets.phases.get(PHASE, {
      zone_id: zoneId,
    })) as CFRuleset;
    return [...(rs.rules ?? [])];
  } catch (raw) {
    const err = toProviderError(raw);
    if (err.code === 'NotFound') return [];
    throw err;
  }
}

async function putPhaseRules(
  ctx: ProviderContext,
  zoneId: string,
  rules: ReadonlyArray<CFRule>,
): Promise<CFRule[]> {
  // The PUT requires `rules` (not full ruleset object). The SDK accepts a typed
  // discriminated union but Cache Rules are a single arm of it; cast through
  // unknown to silence the over-eager param type.
  const rs = (await ctx.cloudflare.rulesets.phases.update(PHASE, {
    zone_id: zoneId,
    rules: rules as unknown as never,
  })) as CFRuleset;
  return [...(rs.rules ?? [])];
}

/**
 * Cache Rules live inside the per-zone, per-phase entrypoint ruleset. A k1c
 * `CacheRule` resource maps to exactly one rule inside that shared ruleset;
 * ownership is tracked via the rule's `description` field, prefixed with
 * `k1c.io/managed=<label>`. Mutations are read-modify-write against the full
 * rules array so non-k1c rules in the same ruleset are preserved.
 *
 * The provider operates against `ctx.zoneId` for list / delete; create + update
 * use `desired.zoneId` so a single apply run can target the same zone via
 * either the env-set ctx zone or the manifest field.
 */
export const cacheRuleProvider: CloudflareResourceProvider<CacheRuleProperties> = {
  resourceType: 'CacheRule',
  schema: cacheRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId);
    for (const rule of rules) {
      if (rule.action !== 'set_cache_settings') continue;
      const parsed = parseDescription(rule.description);
      if (parsed === null || !rule.id) continue;
      yield { nativeId: rule.id, label: parsed.label };
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    const rules = await getPhaseRules(ctx, ctx.zoneId);
    const rule = rules.find((r) => r.id === nativeId);
    if (!rule) return NotFound;
    const props = rulePropsFromCF(rule, ctx.zoneId);
    if (props === null) return NotFound;
    return props;
  },

  async create(ctx, label, desired): Promise<CreateResult> {
    try {
      const existing = await getPhaseRules(ctx, desired.zoneId);
      const newRule = ruleFromProps(desired, label);
      const updated = await putPhaseRules(ctx, desired.zoneId, [...existing, newRule]);
      // Find the newly inserted rule by description match (Cloudflare assigns the id).
      const targetDesc = newRule.description!;
      const created = updated.find((r) => r.description === targetDesc);
      if (!created || !created.id) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message: 'CacheRule create: PUT succeeded but the new rule was not found in the response',
        };
      }
      return { kind: 'sync', nativeId: created.id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const existing = await getPhaseRules(ctx, desired.zoneId);
      const idx = existing.findIndex((r) => r.id === nativeId);
      if (idx < 0) {
        throw {
          code: 'NotFound',
          recoverable: false,
          message: `CacheRule update: rule ${nativeId} no longer present in zone ruleset`,
        };
      }
      const replaced = [...existing];
      // Keep the same id so Cloudflare patches the existing rule rather than appending.
      const label = parseDescription(existing[idx]!.description)?.label ?? '';
      replaced[idx] = ruleFromProps(desired, label, nativeId);
      const updated = await putPhaseRules(ctx, desired.zoneId, replaced);
      const next = updated.find((r) => r.id === nativeId) ?? updated[idx];
      return { kind: 'sync', nativeId: next?.id ?? nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'CacheRule delete requires zoneId in ProviderContext',
      };
    }
    try {
      const existing = await getPhaseRules(ctx, ctx.zoneId);
      const filtered = existing.filter((r) => r.id !== nativeId);
      if (filtered.length === existing.length) {
        // Already gone; treat as success.
        return { kind: 'sync' };
      }
      await putPhaseRules(ctx, ctx.zoneId, filtered);
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
