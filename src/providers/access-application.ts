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

export type AccessDecisionWire = 'allow' | 'deny' | 'bypass' | 'non_identity';

/**
 * SDK-shaped (snake_case) Access rule. The lowering layer translates the camelCase
 * manifest form into this once and the provider then ferries it across the API
 * verbatim. Keeping a flat wire shape here makes the discriminated union match
 * Cloudflare's response without a second translation step.
 */
export type AccessRuleWire =
  | { readonly email: { readonly email: string } }
  | { readonly email_domain: { readonly domain: string } }
  | { readonly everyone: Readonly<Record<string, never>> }
  | { readonly ip: { readonly ip: string } }
  | { readonly country: { readonly country_code: string } }
  | { readonly service_token: { readonly token_id: string } }
  | { readonly any_valid_service_token: Readonly<Record<string, never>> };

export interface AccessAppPolicyWire {
  readonly name: string;
  readonly decision: AccessDecisionWire;
  readonly include: ReadonlyArray<AccessRuleWire>;
  readonly exclude?: ReadonlyArray<AccessRuleWire>;
  readonly require?: ReadonlyArray<AccessRuleWire>;
  readonly session_duration?: string;
}

export type AccessApplicationTypeWire = 'self_hosted' | 'ssh' | 'vnc' | 'bookmark';

export interface AccessApplicationProperties {
  readonly appName: string;
  readonly domain: string;
  readonly appType: AccessApplicationTypeWire;
  readonly sessionDuration?: string;
  readonly autoRedirectToIdentity?: boolean;
  readonly allowedIdps?: ReadonlyArray<string>;
  /**
   * Policy entries. Each item is either an inline policy (AccessAppPolicyWire)
   * or a string holding the policy's Cloudflare UUID (typically materialized
   * from a `<resolved-at-apply:AccessPolicy:<label>>` placeholder by the
   * apply-time resolver). Empty for `bookmark` applications.
   */
  readonly policies: ReadonlyArray<AccessAppPolicyWire | string>;
  readonly logoUrl?: string;
  readonly appLauncherVisible?: boolean;
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

const accessAppPolicyWireSchema: z.ZodType<AccessAppPolicyWire> = z.object({
  name: z.string(),
  decision: z.enum(['allow', 'deny', 'bypass', 'non_identity']),
  include: z.array(accessRuleWireSchema),
  exclude: z.array(accessRuleWireSchema).optional(),
  require: z.array(accessRuleWireSchema).optional(),
  session_duration: z.string().optional(),
});

export const accessApplicationSchema: z.ZodType<AccessApplicationProperties> = z.object({
  appName: z.string(),
  domain: z.string(),
  appType: z.enum(['self_hosted', 'ssh', 'vnc', 'bookmark']),
  sessionDuration: z.string().optional(),
  autoRedirectToIdentity: z.boolean().optional(),
  allowedIdps: z.array(z.string()).optional(),
  policies: z.array(z.union([accessAppPolicyWireSchema, z.string()])),
  logoUrl: z.string().optional(),
  appLauncherVisible: z.boolean().optional(),
});

const NAME_PREFIX = 'k1c-';

/**
 * Cloudflare Access Applications carry no per-app comment field, so ownership is
 * inferred from the application name starting with the `k1c-` prefix. This is
 * the same approach used by other prefix-named resources.
 */
function parseLabel(name: string | undefined | null): string | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

interface CFApp {
  readonly id?: string;
  readonly name?: string;
  readonly domain?: string;
  readonly type?: string;
  readonly session_duration?: string;
  readonly auto_redirect_to_identity?: boolean;
  readonly allowed_idps?: ReadonlyArray<string>;
  readonly policies?: ReadonlyArray<unknown>;
}

function buildBody(props: AccessApplicationProperties) {
  // Bookmark applications carry no policies / session_duration / IdP config —
  // they are App Launcher tiles, not gated apps. Sending policies through to
  // a bookmark create would have Cloudflare reject the request.
  if (props.appType === 'bookmark') {
    return {
      name: props.appName,
      domain: props.domain,
      type: 'bookmark' as const,
      ...(props.logoUrl !== undefined ? { logo_url: props.logoUrl } : {}),
      ...(props.appLauncherVisible !== undefined
        ? { app_launcher_visible: props.appLauncherVisible }
        : {}),
    };
  }
  return {
    name: props.appName,
    domain: props.domain,
    type: props.appType,
    ...(props.sessionDuration !== undefined ? { session_duration: props.sessionDuration } : {}),
    ...(props.autoRedirectToIdentity !== undefined
      ? { auto_redirect_to_identity: props.autoRedirectToIdentity }
      : {}),
    ...(props.allowedIdps !== undefined ? { allowed_idps: [...props.allowedIdps] } : {}),
    ...(props.appLauncherVisible !== undefined
      ? { app_launcher_visible: props.appLauncherVisible }
      : {}),
    policies: props.policies.map((p) => {
      // Strings are policy UUIDs (e.g. resolved from <resolved-at-apply:AccessPolicy:...>);
      // pass through as-is so the SDK references the existing reusable policy.
      if (typeof p === 'string') return p;
      return {
        name: p.name,
        decision: p.decision,
        include: [...p.include],
        ...(p.exclude !== undefined ? { exclude: [...p.exclude] } : {}),
        ...(p.require !== undefined ? { require: [...p.require] } : {}),
        ...(p.session_duration !== undefined ? { session_duration: p.session_duration } : {}),
      };
    }),
  };
}

export const accessApplicationProvider: CloudflareResourceProvider<AccessApplicationProperties> = {
  resourceType: 'AccessApplication',
  schema: accessApplicationSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.zeroTrust.access.applications.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const app of iter) {
        const a = app as CFApp;
        if (!a.id) continue;
        const label = parseLabel(a.name);
        if (label === null) continue;
        yield { nativeId: a.id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const app = (await ctx.cloudflare.zeroTrust.access.applications.get(nativeId, {
        account_id: ctx.accountId,
      })) as CFApp;
      if (!app.name || !app.domain) return NotFound;
      // Reading back the policies is best-effort: Cloudflare returns a richer shape
      // than we store, so we narrow back to the wire types we know how to emit.
      // Unknown rule types are dropped from the read result, which means a manual
      // edit in the dashboard may produce a perpetual "drift" — accepted for v0.4.
      const policies: AccessAppPolicyWire[] = [];
      for (const raw of app.policies ?? []) {
        const p = raw as {
          name?: string;
          decision?: AccessDecisionWire;
          include?: ReadonlyArray<unknown>;
          exclude?: ReadonlyArray<unknown>;
          require?: ReadonlyArray<unknown>;
          session_duration?: string;
        };
        if (!p.name || !p.decision || !p.include) continue;
        policies.push({
          name: p.name,
          decision: p.decision,
          include: p.include as ReadonlyArray<AccessRuleWire>,
          ...(p.exclude !== undefined
            ? { exclude: p.exclude as ReadonlyArray<AccessRuleWire> }
            : {}),
          ...(p.require !== undefined
            ? { require: p.require as ReadonlyArray<AccessRuleWire> }
            : {}),
          ...(p.session_duration !== undefined ? { session_duration: p.session_duration } : {}),
        });
      }
      return {
        appName: app.name,
        domain: app.domain,
        appType: (app.type as AccessApplicationTypeWire) ?? 'self_hosted',
        ...(app.session_duration !== undefined
          ? { sessionDuration: app.session_duration }
          : {}),
        ...(app.auto_redirect_to_identity !== undefined
          ? { autoRedirectToIdentity: app.auto_redirect_to_identity }
          : {}),
        ...(app.allowed_idps !== undefined ? { allowedIdps: [...app.allowed_idps] } : {}),
        policies,
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const app = (await ctx.cloudflare.zeroTrust.access.applications.create({
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never)) as CFApp;
      return {
        kind: 'sync',
        nativeId: app.id ?? desired.appName,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const app = (await ctx.cloudflare.zeroTrust.access.applications.update(nativeId, {
        account_id: ctx.accountId,
        ...buildBody(desired),
      } as never)) as CFApp;
      return {
        kind: 'sync',
        nativeId: app.id ?? nativeId,
        properties: desired,
      };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.zeroTrust.access.applications.delete(nativeId, {
        account_id: ctx.accountId,
      });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
