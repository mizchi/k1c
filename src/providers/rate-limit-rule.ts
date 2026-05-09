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

export type RateLimitAction = 'block' | 'managed_challenge' | 'js_challenge' | 'log';

const RATE_LIMIT_ACTIONS: ReadonlyArray<RateLimitAction> = [
  'block',
  'managed_challenge',
  'js_challenge',
  'log',
];

export interface RateLimitConfig {
  /**
   * Request fingerprint dimensions. Each entry is a Cloudflare Filter
   * Language reference (e.g. `ip.src`, `cf.colo.id`, `http.request.uri.path`).
   * The counter is incremented per unique tuple.
   */
  readonly characteristics: ReadonlyArray<string>;
  /** Counter window in seconds. */
  readonly period: number;
  /** Threshold: requests over `period` before the action triggers. */
  readonly requestsPerPeriod: number;
  /** Optional secondary timeout (seconds) the action stays in effect after the threshold is crossed. */
  readonly mitigationTimeout?: number;
  /** Counts requests against the threshold based on this expression instead of the rule's `expression`. */
  readonly countingExpression?: string;
  /** When true, treat all requests with the same fingerprint as a single account, regardless of header sub-fields. */
  readonly requestsToOrigin?: boolean;
}

export interface RateLimitRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly action: RateLimitAction;
  readonly enabled: boolean;
  readonly ratelimit: RateLimitConfig;
  readonly description?: string;
}

const ratelimitConfigSchema: z.ZodType<RateLimitConfig> = z.object({
  characteristics: z.array(z.string()).min(1),
  period: z.number().int().positive(),
  requestsPerPeriod: z.number().int().positive(),
  mitigationTimeout: z.number().int().nonnegative().optional(),
  countingExpression: z.string().optional(),
  requestsToOrigin: z.boolean().optional(),
});

export const rateLimitRulePropertiesSchema: z.ZodType<RateLimitRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  action: z.enum(['block', 'managed_challenge', 'js_challenge', 'log']),
  enabled: z.boolean(),
  ratelimit: ratelimitConfigSchema,
  description: z.string().optional(),
});

const PHASE = 'http_ratelimit' as const;

interface CFRateLimit {
  readonly characteristics: ReadonlyArray<string>;
  readonly period: number;
  readonly requests_per_period: number;
  readonly mitigation_timeout?: number;
  readonly counting_expression?: string;
  readonly requests_to_origin?: boolean;
}

function ruleFromProps(props: RateLimitRuleProperties, label: string, id?: string): CFRule {
  const ratelimit: CFRateLimit = {
    characteristics: [...props.ratelimit.characteristics],
    period: props.ratelimit.period,
    requests_per_period: props.ratelimit.requestsPerPeriod,
    ...(props.ratelimit.mitigationTimeout !== undefined
      ? { mitigation_timeout: props.ratelimit.mitigationTimeout }
      : {}),
    ...(props.ratelimit.countingExpression !== undefined
      ? { counting_expression: props.ratelimit.countingExpression }
      : {}),
    ...(props.ratelimit.requestsToOrigin !== undefined
      ? { requests_to_origin: props.ratelimit.requestsToOrigin }
      : {}),
  };
  return {
    ...(id !== undefined ? { id } : {}),
    action: props.action,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
    ratelimit,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): RateLimitRuleProperties | null {
  if (!rule.expression || !rule.action) return null;
  if (!RATE_LIMIT_ACTIONS.includes(rule.action as RateLimitAction)) return null;
  const rl = rule.ratelimit as CFRateLimit | undefined;
  if (!rl?.characteristics || rl.period === undefined) return null;
  const parsed = parseDescription(rule.description);
  const ratelimit: RateLimitConfig = {
    characteristics: [...rl.characteristics],
    period: rl.period,
    requestsPerPeriod: rl.requests_per_period,
    ...(rl.mitigation_timeout !== undefined ? { mitigationTimeout: rl.mitigation_timeout } : {}),
    ...(rl.counting_expression !== undefined ? { countingExpression: rl.counting_expression } : {}),
    ...(rl.requests_to_origin !== undefined ? { requestsToOrigin: rl.requests_to_origin } : {}),
  };
  return {
    zoneId,
    expression: rule.expression,
    action: rule.action as RateLimitAction,
    enabled: rule.enabled ?? true,
    ratelimit,
    ...(parsed?.userDescription !== undefined ? { description: parsed.userDescription } : {}),
  };
}

/**
 * Rate Limiting Rules manage rate-based actions in the `http_ratelimit` phase
 * ruleset. The `characteristics` array defines the request fingerprint the
 * counter buckets by; common choices are `ip.src`, `cf.colo.id`, and
 * `http.request.uri.path`. See Cloudflare's "Advanced Rate Limiting" docs for
 * the full set of supported expression fields.
 */
export const rateLimitRuleProvider: CloudflareResourceProvider<RateLimitRuleProperties> = {
  resourceType: 'RateLimitRule',
  schema: rateLimitRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (!rule.action || !RATE_LIMIT_ACTIONS.includes(rule.action as RateLimitAction)) continue;
      if (!rule.ratelimit) continue;
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
          message: 'RateLimitRule create: PUT succeeded but the new rule was not found in the response',
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
          message: `RateLimitRule update: rule ${nativeId} no longer present in zone ruleset`,
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
        message: 'RateLimitRule delete requires zoneId in ProviderContext',
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
