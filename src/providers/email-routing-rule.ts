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

export type EmailRoutingMatcher =
  | { readonly type: 'all' }
  | { readonly type: 'literal'; readonly field: 'to'; readonly value: string };

export type EmailRoutingAction =
  | { readonly type: 'drop' }
  | { readonly type: 'forward'; readonly to: ReadonlyArray<string> }
  | { readonly type: 'worker'; readonly worker: string };

export interface EmailRoutingRuleProperties {
  readonly zoneId: string;
  readonly ruleName: string;
  readonly enabled: boolean;
  readonly priority?: number;
  readonly matchers: ReadonlyArray<EmailRoutingMatcher>;
  readonly actions: ReadonlyArray<EmailRoutingAction>;
}

const matcherSchema: z.ZodType<EmailRoutingMatcher> = z.union([
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('literal'), field: z.literal('to'), value: z.string() }),
]);

const actionSchema: z.ZodType<EmailRoutingAction> = z.union([
  z.object({ type: z.literal('drop') }),
  z.object({ type: z.literal('forward'), to: z.array(z.string()) }),
  z.object({ type: z.literal('worker'), worker: z.string() }),
]);

export const emailRoutingRulePropertiesSchema: z.ZodType<EmailRoutingRuleProperties> = z.object({
  zoneId: z.string(),
  ruleName: z.string(),
  enabled: z.boolean(),
  priority: z.number().int().nonnegative().optional(),
  matchers: z.array(matcherSchema),
  actions: z.array(actionSchema),
});

const NAME_PREFIX = 'k1c:';

interface CFAction {
  readonly type?: string;
  readonly value?: ReadonlyArray<string>;
}

interface CFMatcher {
  readonly type?: string;
  readonly field?: string;
  readonly value?: string;
}

interface CFRule {
  readonly id?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly actions?: ReadonlyArray<CFAction>;
  readonly matchers?: ReadonlyArray<CFMatcher>;
}

/**
 * Cloudflare's emailRouting.rules API has no comment / tag field, so ownership
 * is encoded in the rule's `name` field with a `k1c:` prefix followed by the
 * resource label. The user-visible name lives in the suffix after the colon.
 */
function parseLabel(name: string | undefined | null): string | null {
  if (typeof name !== 'string') return null;
  if (!name.startsWith(NAME_PREFIX)) return null;
  return name.slice(NAME_PREFIX.length);
}

function buildName(label: string, ruleName: string): string {
  // Encode both the ownership label and the user-facing rule name so that
  // a list response can recover the label without an extra round trip.
  return `${NAME_PREFIX}${label}|${ruleName}`;
}

function userFacingNameFromCF(name: string | undefined | null): string {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return name ?? '';
  const rest = name.slice(NAME_PREFIX.length);
  const pipe = rest.indexOf('|');
  return pipe < 0 ? rest : rest.slice(pipe + 1);
}

function actionToWire(action: EmailRoutingAction): { type: string; value?: string[] } {
  if (action.type === 'drop') return { type: 'drop' };
  if (action.type === 'forward') return { type: 'forward', value: [...action.to] };
  return { type: 'worker', value: [action.worker] };
}

function actionFromCF(a: CFAction): EmailRoutingAction | null {
  if (a.type === 'drop') return { type: 'drop' };
  if (a.type === 'forward') return { type: 'forward', to: [...(a.value ?? [])] };
  if (a.type === 'worker') return { type: 'worker', worker: a.value?.[0] ?? '' };
  return null;
}

function matcherToWire(m: EmailRoutingMatcher): CFMatcher {
  if (m.type === 'all') return { type: 'all' };
  return { type: 'literal', field: m.field, value: m.value };
}

function matcherFromCF(m: CFMatcher): EmailRoutingMatcher | null {
  if (m.type === 'all') return { type: 'all' };
  if (m.type === 'literal' && m.field === 'to' && typeof m.value === 'string') {
    return { type: 'literal', field: 'to', value: m.value };
  }
  return null;
}

function buildBody(props: EmailRoutingRuleProperties, label: string) {
  return {
    zone_id: props.zoneId,
    name: buildName(label, props.ruleName),
    enabled: props.enabled,
    ...(props.priority !== undefined ? { priority: props.priority } : {}),
    matchers: props.matchers.map(matcherToWire),
    actions: props.actions.map(actionToWire),
  };
}

export const emailRoutingRuleProvider: CloudflareResourceProvider<EmailRoutingRuleProperties> = {
  resourceType: 'EmailRoutingRule',
  schema: emailRoutingRulePropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    if (ctx.zoneId === undefined) return;
    let iter;
    try {
      iter = ctx.cloudflare.emailRouting.rules.list({ zone_id: ctx.zoneId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const r of iter) {
        const rr = r as CFRule;
        if (!rr.id) continue;
        const labelWithName = parseLabel(rr.name);
        if (labelWithName === null) continue;
        const pipe = labelWithName.indexOf('|');
        const label = pipe < 0 ? labelWithName : labelWithName.slice(0, pipe);
        yield { nativeId: rr.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    if (ctx.zoneId === undefined) return NotFound;
    try {
      const r = (await ctx.cloudflare.emailRouting.rules.get(nativeId, {
        zone_id: ctx.zoneId,
      })) as CFRule;
      if (!r.matchers || !r.actions) return NotFound;
      const matchers: EmailRoutingMatcher[] = [];
      for (const m of r.matchers) {
        const decoded = matcherFromCF(m);
        if (decoded !== null) matchers.push(decoded);
      }
      const actions: EmailRoutingAction[] = [];
      for (const a of r.actions) {
        const decoded = actionFromCF(a);
        if (decoded !== null) actions.push(decoded);
      }
      return {
        zoneId: ctx.zoneId,
        ruleName: userFacingNameFromCF(r.name),
        enabled: r.enabled ?? true,
        ...(r.priority !== undefined ? { priority: r.priority } : {}),
        matchers,
        actions,
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, label, desired): Promise<CreateResult> {
    try {
      const r = (await ctx.cloudflare.emailRouting.rules.create(
        buildBody(desired, label) as never,
      )) as CFRule;
      if (!r.id) {
        throw {
          code: 'ServiceInternalError',
          recoverable: true,
          message: 'EmailRoutingRule create: API response missing id',
        };
      }
      return { kind: 'sync', nativeId: r.id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'EmailRoutingRule update requires zoneId in ProviderContext',
      };
    }
    try {
      // Recover the existing label from the rule's name field so the marker
      // prefix survives the update. We could thread it through the apply
      // layer, but a single GET is simpler than rerouting state.
      const existing = (await ctx.cloudflare.emailRouting.rules.get(nativeId, {
        zone_id: ctx.zoneId,
      })) as CFRule;
      const labelWithName = parseLabel(existing.name);
      const pipe = labelWithName?.indexOf('|') ?? -1;
      const label = labelWithName !== null && pipe >= 0 ? labelWithName.slice(0, pipe) : '';
      const r = (await ctx.cloudflare.emailRouting.rules.update(
        nativeId,
        buildBody(desired, label) as never,
      )) as CFRule;
      return { kind: 'sync', nativeId: r.id ?? nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    if (ctx.zoneId === undefined) {
      throw {
        code: 'InvalidRequest',
        recoverable: false,
        message: 'EmailRoutingRule delete requires zoneId in ProviderContext',
      };
    }
    try {
      await ctx.cloudflare.emailRouting.rules.delete(nativeId, { zone_id: ctx.zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};

