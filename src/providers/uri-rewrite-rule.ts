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

export type URIPart =
  | { readonly value: string }       // static replacement
  | { readonly expression: string }; // dynamic replacement

export interface URIRewriteRuleProperties {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled: boolean;
  /** At least one of `path` / `query` must be set. */
  readonly path?: URIPart;
  readonly query?: URIPart;
  readonly description?: string;
}

const uriPartSchema: z.ZodType<URIPart> = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ expression: z.string() }).strict(),
]);

export const uriRewriteRulePropertiesSchema: z.ZodType<URIRewriteRuleProperties> = z.object({
  zoneId: z.string(),
  expression: z.string(),
  enabled: z.boolean(),
  path: uriPartSchema.optional(),
  query: uriPartSchema.optional(),
  description: z.string().optional(),
});

const PHASE = 'http_request_transform' as const;

interface CFRewriteActionParameters {
  readonly uri?: { path?: URIPart; query?: URIPart };
}

function ruleFromProps(props: URIRewriteRuleProperties, label: string, id?: string): CFRule {
  const uri: { path?: URIPart; query?: URIPart } = {};
  if (props.path !== undefined) uri.path = props.path;
  if (props.query !== undefined) uri.query = props.query;
  return {
    ...(id !== undefined ? { id } : {}),
    action: 'rewrite',
    action_parameters: { uri } as CFRewriteActionParameters,
    description: buildDescription(label, props.description),
    enabled: props.enabled,
    expression: props.expression,
  };
}

function rulePropsFromCF(rule: CFRule, zoneId: string): URIRewriteRuleProperties | null {
  if (!rule.expression || rule.action !== 'rewrite') return null;
  const ap = (rule.action_parameters ?? {}) as CFRewriteActionParameters;
  if (!ap.uri || (ap.uri.path === undefined && ap.uri.query === undefined)) return null;
  const parsed = parseDescription(rule.description);
  return {
    zoneId,
    expression: rule.expression,
    enabled: rule.enabled ?? true,
    ...(ap.uri.path !== undefined ? { path: ap.uri.path } : {}),
    ...(ap.uri.query !== undefined ? { query: ap.uri.query } : {}),
    ...(parsed?.userDescription !== undefined ? { description: parsed.userDescription } : {}),
  };
}

/**
 * URI rewrites live in the `http_request_transform` phase ruleset (different
 * from `TransformRule`'s `http_request_late_transform`, which carries the
 * request *header* rewrites). They share the `rewrite` action but with
 * `action_parameters.uri.{path,query}` instead of `headers`. Distinguishing at
 * the CFRule level: a rewrite rule with non-empty `uri` belongs here; one
 * with non-empty `headers` and no `uri` belongs in TransformRule.
 */
export const uriRewriteRuleProvider: CloudflareResourceProvider<URIRewriteRuleProperties> = {
  resourceType: 'URIRewriteRule',
  schema: uriRewriteRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    const rules = await getPhaseRules(ctx, ctx.zoneId, PHASE);
    for (const rule of rules) {
      if (rule.action !== 'rewrite') continue;
      const ap = (rule.action_parameters ?? {}) as CFRewriteActionParameters;
      if (!ap.uri || (ap.uri.path === undefined && ap.uri.query === undefined)) continue;
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
          message: 'URIRewriteRule create: PUT succeeded but the new rule was not found in the response',
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
          message: `URIRewriteRule update: rule ${nativeId} no longer present in zone ruleset`,
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
        message: 'URIRewriteRule delete requires zoneId in ProviderContext',
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
