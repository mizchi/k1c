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
import { makeEquals } from './_equality.ts';

/**
 * Cloudflare account-level notification policy (alerting/policies).
 *
 * The `alertType` enum is large (60+ values); we expose it as a string
 * and rely on the Cloudflare API to validate, since hard-coding the
 * union here would drift every time Cloudflare adds an alert kind.
 *
 * `filters` is a Record<string, string[]> passthrough — different alert
 * types use different filter keys, all of which the SDK accepts under
 * the same shape.
 *
 * list() filters by a `k1c-<ns>-<name>` name prefix; lower sets that
 * up so the operator can adopt rows it created earlier.
 */
export type NotificationMechanism = {
  readonly email?: ReadonlyArray<{ readonly id: string }>;
  readonly pagerduty?: ReadonlyArray<{ readonly id: string }>;
  readonly webhooks?: ReadonlyArray<{ readonly id: string }>;
};

export interface NotificationPolicyProperties {
  /** Display name; prefixed with `k1c-<ns>-<name>` by the lower layer. */
  readonly policyName: string;
  readonly alertType: string;
  readonly enabled: boolean;
  readonly mechanisms: NotificationMechanism;
  readonly description?: string;
  readonly alertInterval?: string;
  readonly filters?: Readonly<Record<string, ReadonlyArray<string>>>;
}

const mechanismSchema: z.ZodType<NotificationMechanism> = z.object({
  email: z.array(z.object({ id: z.string() })).optional(),
  pagerduty: z.array(z.object({ id: z.string() })).optional(),
  webhooks: z.array(z.object({ id: z.string() })).optional(),
});

export const notificationPolicyPropertiesSchema: z.ZodType<NotificationPolicyProperties> =
  z.object({
    policyName: z.string(),
    alertType: z.string(),
    enabled: z.boolean(),
    mechanisms: mechanismSchema,
    description: z.string().optional(),
    alertInterval: z.string().optional(),
    filters: z.record(z.array(z.string())).optional(),
  });

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string | undefined): string | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

function normalizeMechanisms(m: NotificationMechanism): unknown {
  const sortIds = (xs?: ReadonlyArray<{ id: string }>) =>
    xs ? [...xs].map((x) => x.id).sort() : [];
  return {
    email: sortIds(m.email),
    pagerduty: sortIds(m.pagerduty),
    webhooks: sortIds(m.webhooks),
  };
}

function normalize(p: NotificationPolicyProperties): unknown {
  return {
    policyName: p.policyName,
    alertType: p.alertType,
    enabled: p.enabled,
    mechanisms: normalizeMechanisms(p.mechanisms),
    description: p.description ?? '',
    alertInterval: p.alertInterval ?? '',
    filters: Object.fromEntries(
      Object.entries(p.filters ?? {})
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  };
}

function toApiBody(p: NotificationPolicyProperties): Record<string, unknown> {
  return {
    name: p.policyName,
    alert_type: p.alertType,
    enabled: p.enabled,
    mechanisms: {
      ...(p.mechanisms.email !== undefined ? { email: p.mechanisms.email.map((e) => ({ id: e.id })) } : {}),
      ...(p.mechanisms.pagerduty !== undefined
        ? { pagerduty: p.mechanisms.pagerduty.map((e) => ({ id: e.id })) }
        : {}),
      ...(p.mechanisms.webhooks !== undefined
        ? { webhooks: p.mechanisms.webhooks.map((e) => ({ id: e.id })) }
        : {}),
    },
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.alertInterval !== undefined ? { alert_interval: p.alertInterval } : {}),
    ...(p.filters !== undefined
      ? {
          filters: Object.fromEntries(
            Object.entries(p.filters).map(([k, v]) => [k, [...v]]),
          ),
        }
      : {}),
  };
}

export const notificationPolicyProvider: CloudflareResourceProvider<NotificationPolicyProperties> =
  {
    resourceType: 'NotificationPolicy',
    schema: notificationPolicyPropertiesSchema,
    equals: makeEquals<NotificationPolicyProperties>(normalize),

    async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
      try {
        const page = await ctx.cloudflare.alerting.policies.list({
          account_id: ctx.accountId,
        });
        for await (const p of page) {
          const label = parseLabel((p as { name?: string }).name);
          if (label === null) continue;
          const id = (p as { id?: string }).id;
          if (typeof id !== 'string') continue;
          yield { nativeId: id, label };
        }
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async read(ctx, nativeId) {
      try {
        const p = (await ctx.cloudflare.alerting.policies.get(nativeId, {
          account_id: ctx.accountId,
        })) as Record<string, unknown>;
        const mech = (p['mechanisms'] as NotificationMechanism | undefined) ?? {};
        return {
          policyName: (p['name'] as string) ?? '',
          alertType: (p['alert_type'] as string) ?? '',
          enabled: (p['enabled'] as boolean) ?? false,
          mechanisms: mech,
          ...(p['description'] !== undefined ? { description: p['description'] as string } : {}),
          ...(p['alert_interval'] !== undefined
            ? { alertInterval: p['alert_interval'] as string }
            : {}),
          ...(p['filters'] !== undefined
            ? { filters: p['filters'] as Record<string, string[]> }
            : {}),
        };
      } catch (raw) {
        const err = toProviderError(raw);
        if (err.code === 'NotFound') return NotFound;
        throw err;
      }
    },

    async create(ctx, _label, desired): Promise<CreateResult> {
      try {
        const p = (await ctx.cloudflare.alerting.policies.create({
          account_id: ctx.accountId,
          ...toApiBody(desired),
        } as never)) as { id?: string };
        const id = p.id ?? '';
        if (!id) {
          throw {
            code: 'ServiceInternalError' as const,
            recoverable: false,
            message: 'NotificationPolicy create returned no id',
          };
        }
        return { kind: 'sync', nativeId: id, properties: desired };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
      try {
        await ctx.cloudflare.alerting.policies.update(nativeId, {
          account_id: ctx.accountId,
          ...toApiBody(desired),
        } as never);
        return { kind: 'sync', nativeId, properties: desired };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },

    async delete(ctx, nativeId): Promise<DeleteResult> {
      try {
        await ctx.cloudflare.alerting.policies.delete(nativeId, {
          account_id: ctx.accountId,
        });
        return { kind: 'sync' };
      } catch (raw) {
        throw toProviderError(raw);
      }
    },
  };
