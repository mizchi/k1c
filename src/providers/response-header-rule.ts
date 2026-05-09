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

export type ResponseHeaderOperation = 'set' | 'add' | 'remove';

export interface ResponseHeaderAction {
  readonly operation: ResponseHeaderOperation;
  /** Required for `set` and `add`; ignored for `remove`. */
  readonly value?: string;
}

export interface ResponseHeaderRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled: boolean;
  /** Header name → operation. At least one entry. */
  readonly headers: Readonly<Record<string, ResponseHeaderAction>>;
  readonly description?: string;
}

const headerActionSchema: z.ZodType<ResponseHeaderAction> = z.object({
  operation: z.enum(['set', 'add', 'remove']),
  value: z.string().optional(),
});

export const responseHeaderRulePropertiesSchema: z.ZodType<ResponseHeaderRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  enabled: z.boolean(),
  headers: z.record(headerActionSchema),
  description: z.string().optional(),
});

const PHASE = 'http_response_headers_transform' as const;

interface CFResponseActionParameters {
  readonly headers?: Readonly<
    Record<string, { operation: ResponseHeaderOperation; value?: string }>
  >;
}

function ruleFromProps(
  props: ResponseHeaderRuleProperties,
  label: string,
  id?: string,
): CFRule {
  const headers: Record<string, { operation: ResponseHeaderOperation; value?: string }> = {};
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
    action_parameters: { headers } as CFResponseActionParameters,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): ResponseHeaderRuleProperties | null {
  if (!rule.expression || rule.action !== 'rewrite') return null;
  const ap = (rule.action_parameters ?? {}) as CFResponseActionParameters;
  if (!ap.headers || Object.keys(ap.headers).length === 0) return null;
  const headers: Record<string, ResponseHeaderAction> = {};
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
 * Response header rewrites live in the `http_response_headers_transform`
 * phase ruleset (request header rewrites are in `http_request_late_transform`,
 * managed by `TransformRule`). The action is `rewrite` with `headers`; the
 * shape is symmetric to TransformRule otherwise.
 */
export const responseHeaderRuleProvider: CloudflareResourceProvider<ResponseHeaderRuleProperties> =
  {
    resourceType: 'ResponseHeaderRule',
    schema: responseHeaderRulePropertiesSchema,

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
            message:
              'ResponseHeaderRule create: PUT succeeded but the new rule was not found in the response',
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
            message: `ResponseHeaderRule update: rule ${nativeId} no longer present in zone ruleset`,
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
          message: 'ResponseHeaderRule delete requires zoneId in ProviderContext',
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
