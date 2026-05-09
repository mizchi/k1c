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

export type WAFManagedOverrideAction =
  | 'block'
  | 'challenge'
  | 'managed_challenge'
  | 'js_challenge'
  | 'log';

export interface WAFManagedRulesetProperties {
  readonly zoneId: string;
  /**
   * UUID of the Cloudflare-managed ruleset to execute. Common values:
   *   - `efb7b8c949ac4650a09736fc376e9aee`  Cloudflare Managed Ruleset
   *   - `4814384a9e5d4991b9815dcfc25d2f1f`  Cloudflare OWASP Core Ruleset
   *   - `c2e184081120413c86c3ab7e14069605`  Cloudflare Exposed Credentials Check
   * Each enabled ruleset adds its own rule entry inside the managed phase
   * ruleset; multiple WAFManagedRuleset CRDs can coexist with different ids.
   */
  readonly rulesetId: string;
  readonly enabled: boolean;
  /** Optional matcher narrowing which requests run through the managed rules. Defaults to `true`. */
  readonly expression?: string;
  /** Override all matched rules with this action. */
  readonly overrideAction?: WAFManagedOverrideAction;
  readonly description?: string;
}

export const wafManagedRulesetPropertiesSchema: z.ZodType<WAFManagedRulesetProperties> = z.object({
  zoneId: z.string(),
  rulesetId: z.string(),
  enabled: z.boolean(),
  expression: z.string().optional(),
  overrideAction: z.enum(['block', 'challenge', 'managed_challenge', 'js_challenge', 'log']).optional(),
  description: z.string().optional(),
});

const PHASE = 'http_request_firewall_managed' as const;

interface CFExecuteParameters {
  readonly id?: string;
  readonly overrides?: { readonly action?: string };
}

function ruleFromProps(props: WAFManagedRulesetProperties, label: string, id?: string): CFRule {
  const actionParameters: CFExecuteParameters = {
    id: props.rulesetId,
    ...(props.overrideAction !== undefined
      ? { overrides: { action: props.overrideAction } }
      : {}),
  };
  return {
    ...(id !== undefined ? { id } : {}),
    action: 'execute',
    action_parameters: actionParameters,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression ?? 'true',
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): WAFManagedRulesetProperties | null {
  if (rule.action !== 'execute') return null;
  const ap = (rule.action_parameters ?? {}) as CFExecuteParameters;
  if (!ap.id) return null;
  const parsed = parseDescription(rule.description);
  return {
    zoneId,
    rulesetId: ap.id,
    enabled: rule.enabled ?? true,
    ...(rule.expression !== undefined && rule.expression !== 'true'
      ? { expression: rule.expression }
      : {}),
    ...(ap.overrides?.action !== undefined
      ? { overrideAction: ap.overrides.action as WAFManagedOverrideAction }
      : {}),
    ...(parsed?.userDescription !== undefined ? { description: parsed.userDescription } : {}),
  };
}

/**
 * Cloudflare-managed WAF rulesets are Cloudflare-authored rule bundles (OWASP
 * Core, Cloudflare Managed, Exposed Credentials Check, ...) the user opts into
 * by creating a single `execute` rule that points at the managed ruleset's
 * UUID. The rule lives inside the zone's `http_request_firewall_managed`
 * phase ruleset alongside any other managed-ruleset opt-ins; user-authored
 * custom rules belong in `WAFCustomRule` instead.
 */
export const wafManagedRulesetProvider: CloudflareResourceProvider<WAFManagedRulesetProperties> = {
  resourceType: 'WAFManagedRuleset',
  schema: wafManagedRulesetPropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (rule.action !== 'execute') continue;
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
      const targetDesc = newRule.description!;
      const created = updated.find((r) => r.description === targetDesc);
      if (!created || !created.id) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message:
            'WAFManagedRuleset create: PUT succeeded but the new rule was not found in the response',
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
          message: `WAFManagedRuleset update: rule ${nativeId} no longer present in zone ruleset`,
        };
      }
      const replaced = [...existing];
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
        message: 'WAFManagedRuleset delete requires zoneId in ProviderContext',
      };
    }
    try {
      const existing = await getPhaseRules(ctx, ctx.zoneId, PHASE);
      const filtered = existing.filter((r) => r.id !== nativeId);
      if (filtered.length === existing.length) return { kind: 'sync' };
      await putPhaseRules(ctx, ctx.zoneId, PHASE, filtered);
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
