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
import type { AccessAppPolicyWire, AccessRuleWire } from './access-application.ts';

export interface AccessPolicyProperties {
  readonly policyName: string;
  readonly decision: AccessAppPolicyWire['decision'];
  readonly include: ReadonlyArray<AccessRuleWire>;
  readonly exclude?: ReadonlyArray<AccessRuleWire>;
  readonly require?: ReadonlyArray<AccessRuleWire>;
  readonly sessionDuration?: string;
}

const accessRuleWireSchema: z.ZodType<AccessRuleWire> = z.union([
  z.object({ email: z.object({ email: z.string() }) }),
  z.object({ email_domain: z.object({ domain: z.string() }) }),
  z.object({ everyone: z.object({}).strict() }),
  z.object({ ip: z.object({ ip: z.string() }) }),
  z.object({ country: z.object({ country_code: z.string() }) }),
  z.object({ service_token: z.object({ token_id: z.string() }) }),
  z.object({ any_valid_service_token: z.object({}).strict() }),
]);

export const accessPolicyPropertiesSchema: z.ZodType<AccessPolicyProperties> = z.object({
  policyName: z.string(),
  decision: z.enum(['allow', 'deny', 'bypass', 'non_identity']),
  include: z.array(accessRuleWireSchema),
  exclude: z.array(accessRuleWireSchema).optional(),
  require: z.array(accessRuleWireSchema).optional(),
  sessionDuration: z.string().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string | undefined | null): string | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

interface CFPolicy {
  readonly id?: string;
  readonly name?: string;
  readonly decision?: AccessPolicyProperties['decision'];
  readonly include?: ReadonlyArray<AccessRuleWire>;
  readonly exclude?: ReadonlyArray<AccessRuleWire>;
  readonly require?: ReadonlyArray<AccessRuleWire>;
  readonly session_duration?: string;
}

function buildBody(props: AccessPolicyProperties) {
  return {
    name: props.policyName,
    decision: props.decision,
    include: [...props.include],
    ...(props.exclude !== undefined ? { exclude: [...props.exclude] } : {}),
    ...(props.require !== undefined ? { require: [...props.require] } : {}),
    ...(props.sessionDuration !== undefined ? { session_duration: props.sessionDuration } : {}),
  };
}

/**
 * Standalone, reusable Access policies are created at the account level and
 * referenced by UUID from one or more `AccessApplication.policies[]` entries.
 * Ownership is inferred from the policy name starting with `k1c-` (Access
 * policies have no comment / tag field, same constraint as AccessApplication).
 *
 * AccessApplication's lowering emits a `<resolved-at-apply:AccessPolicy:label>`
 * placeholder for each ref; the apply-time resolver replaces it with the
 * UUID returned by this provider's create.
 */
export const accessPolicyProvider: CloudflareResourceProvider<AccessPolicyProperties> = {
  resourceType: 'AccessPolicy',
  schema: accessPolicyPropertiesSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.zeroTrust.access.policies.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const p of iter) {
        const pp = p as CFPolicy;
        if (!pp.id) continue;
        const label = parseLabel(pp.name);
        if (label === null) continue;
        yield { nativeId: pp.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const p = (await ctx.cloudflare.zeroTrust.access.policies.get(nativeId, {
        account_id: ctx.accountId,
      })) as CFPolicy;
      if (!p.name || !p.decision || !p.include) return NotFound;
      return {
        policyName: p.name,
        decision: p.decision,
        include: [...p.include],
        ...(p.exclude !== undefined ? { exclude: [...p.exclude] } : {}),
        ...(p.require !== undefined ? { require: [...p.require] } : {}),
        ...(p.session_duration !== undefined ? { sessionDuration: p.session_duration } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const p = (await ctx.cloudflare.zeroTrust.access.policies.create({
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never)) as CFPolicy;
      return { kind: 'sync', nativeId: p.id ?? desired.policyName, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const p = (await ctx.cloudflare.zeroTrust.access.policies.update(nativeId, {
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never)) as CFPolicy;
      return { kind: 'sync', nativeId: p.id ?? nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.zeroTrust.access.policies.delete(nativeId, {
        account_id: ctx.accountId,
      });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
