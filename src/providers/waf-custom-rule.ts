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

export type WAFAction =
  | 'block'
  | 'challenge'
  | 'managed_challenge'
  | 'js_challenge'
  | 'log'
  | 'skip';

const WAF_ACTIONS: ReadonlyArray<WAFAction> = [
  'block',
  'challenge',
  'managed_challenge',
  'js_challenge',
  'log',
  'skip',
];

export interface WAFCustomRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly action: WAFAction;
  readonly enabled: boolean;
  readonly description?: string;
}

export const wafCustomRulePropertiesSchema: z.ZodType<WAFCustomRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  action: z.enum(['block', 'challenge', 'managed_challenge', 'js_challenge', 'log', 'skip']),
  enabled: z.boolean(),
  description: z.string().optional(),
});

const PHASE = 'http_request_firewall_custom' as const;

function ruleFromProps(props: WAFCustomRuleProperties, label: string, id?: string): CFRule {
  return {
    ...(id !== undefined ? { id } : {}),
    action: props.action,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): WAFCustomRuleProperties | null {
  if (!rule.expression || !rule.action) return null;
  if (!WAF_ACTIONS.includes(rule.action as WAFAction)) return null;
  const parsed = parseDescription(rule.description);
  return {
    zoneId,
    expression: rule.expression,
    action: rule.action as WAFAction,
    enabled: rule.enabled ?? true,
    ...(parsed?.userDescription !== undefined ? { description: parsed.userDescription } : {}),
  };
}

/**
 * WAF Custom Rules manage block / challenge / log actions in the
 * `http_request_firewall_custom` phase ruleset. Cloudflare-managed rule
 * groups (the ones included with the WAF Managed Rules product) live in a
 * different phase and are not exposed here — only user-authored custom rules.
 */
export const wafCustomRuleProvider: CloudflareResourceProvider<WAFCustomRuleProperties> = {
  resourceType: 'WAFCustomRule',
  schema: wafCustomRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (!rule.action || !WAF_ACTIONS.includes(rule.action as WAFAction)) continue;
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
          message: 'WAFCustomRule create: PUT succeeded but the new rule was not found in the response',
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
          message: `WAFCustomRule update: rule ${nativeId} no longer present in zone ruleset`,
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
        message: 'WAFCustomRule delete requires zoneId in ProviderContext',
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
