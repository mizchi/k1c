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

export type TransformHeaderOperation = 'set' | 'add' | 'remove';

export interface TransformHeaderAction {
  readonly operation: TransformHeaderOperation;
  /** Required for `set` and `add`; ignored for `remove`. */
  readonly value?: string;
}

export interface TransformRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled: boolean;
  /** Header name → operation. At least one entry. */
  readonly headers: Readonly<Record<string, TransformHeaderAction>>;
  readonly description?: string;
}

const headerActionSchema: z.ZodType<TransformHeaderAction> = z.object({
  operation: z.enum(['set', 'add', 'remove']),
  value: z.string().optional(),
});

export const transformRulePropertiesSchema: z.ZodType<TransformRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  enabled: z.boolean(),
  headers: z.record(headerActionSchema),
  description: z.string().optional(),
});

const PHASE = 'http_request_late_transform' as const;

interface CFTransformActionParameters {
  readonly headers?: Readonly<Record<string, { operation: TransformHeaderOperation; value?: string }>>;
}

function ruleFromProps(props: TransformRuleProperties, label: string, id?: string): CFRule {
  const headers: Record<string, { operation: TransformHeaderOperation; value?: string }> = {};
  for (const [name, action] of Object.entries(props.headers)) {
    headers[name] =
      action.operation === 'remove'
        ? { operation: 'remove' }
        : {
            operation: action.operation,
            ...(action.value !== undefined ? { value: action.value } : {}),
          };
  }
  return {
    ...(id !== undefined ? { id } : {}),
    action: 'rewrite',
    action_parameters: { headers } as CFTransformActionParameters,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): TransformRuleProperties | null {
  if (!rule.expression || rule.action !== 'rewrite') return null;
  const ap = (rule.action_parameters ?? {}) as CFTransformActionParameters;
  if (!ap.headers || Object.keys(ap.headers).length === 0) return null;
  const headers: Record<string, TransformHeaderAction> = {};
  for (const [name, action] of Object.entries(ap.headers)) {
    headers[name] =
      action.operation === 'remove'
        ? { operation: 'remove' }
        : {
            operation: action.operation,
            ...(action.value !== undefined ? { value: action.value } : {}),
          };
  }
  const parsed = parseDescription(rule.description);
  return {
    zoneId,
    expression: rule.expression,
    enabled: rule.enabled ?? true,
    headers,
    ...(parsed?.userDescription !== undefined ? { description: parsed.userDescription } : {}),
  };
}

/**
 * Transform Rules manage HTTP request header rewrites in the
 * `http_request_late_transform` phase ruleset. URI rewrites and response
 * header rewrites are not yet supported — they each need their own phase
 * (`http_request_transform` and `http_response_headers_transform`); adding
 * them later is a separate CRD per phase, not an extension of this one.
 */
export const transformRuleProvider: CloudflareResourceProvider<TransformRuleProperties> = {
  resourceType: 'TransformRule',
  schema: transformRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (rule.action !== 'rewrite') continue;
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
          message: 'TransformRule create: PUT succeeded but the new rule was not found in the response',
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
          message: `TransformRule update: rule ${nativeId} no longer present in zone ruleset`,
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
        message: 'TransformRule delete requires zoneId in ProviderContext',
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
