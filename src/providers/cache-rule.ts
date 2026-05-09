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
import {
  buildDescription,
  getPhaseRules,
  parseDescription,
  putPhaseRules,
} from './_ruleset-shared.ts';
import type { CFRule } from './_ruleset-shared.ts';

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

interface CFCacheActionParameters {
  readonly cache?: boolean;
  readonly edge_ttl?: { mode: CacheRuleTtlMode; default?: number };
  readonly browser_ttl?: { mode: CacheRuleTtlMode; default?: number };
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
  const ap = (rule.action_parameters ?? {}) as CFCacheActionParameters;
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
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (rule.action !== 'set_cache_settings') continue;
      const parsed = parseDescription(rule.description);
      if (parsed === null || !rule.id) continue;
      yield { nativeId: rule.id, label: parsed.label };
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    const rule = rules.find((r) => r.id === nativeId);
    if (!rule) return NotFound;
    const props = rulePropsFromCF(rule, ctx.zoneId);
    if (props === null) return NotFound;
    return props;
  },

  async create(ctx, label, desired): Promise<CreateResult> {
    try {
      const existing = await getPhaseRules(ctx, desired.zoneId, PHASE);
      const newRule = ruleFromProps(desired, label);
      const updated = await putPhaseRules(ctx, desired.zoneId, PHASE, [...existing, newRule]);
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
      const existing = await getPhaseRules(ctx, desired.zoneId, PHASE);
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
      const updated = await putPhaseRules(ctx, desired.zoneId, PHASE, replaced);
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
      const existing = await getPhaseRules(ctx, ctx.zoneId, PHASE);
      const filtered = existing.filter((r) => r.id !== nativeId);
      if (filtered.length === existing.length) {
        // Already gone; treat as success.
        return { kind: 'sync' };
      }
      await putPhaseRules(ctx, ctx.zoneId, PHASE, filtered);
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
