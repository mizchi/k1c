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

export type TurnstileMode = 'non-interactive' | 'invisible' | 'managed';
export type TurnstileClearanceLevel =
  | 'no_clearance'
  | 'jschallenge'
  | 'managed'
  | 'interactive';
export type TurnstileRegion = 'world' | 'china';

export interface TurnstileWidgetProperties {
  /** Display name — k1c-prefixed so list() can identify managed widgets. */
  readonly widgetName: string;
  readonly domains: ReadonlyArray<string>;
  readonly mode: TurnstileMode;
  readonly botFightMode?: boolean;
  readonly clearanceLevel?: TurnstileClearanceLevel;
  readonly ephemeralId?: boolean;
  readonly offlabel?: boolean;
  readonly region?: TurnstileRegion;
}

export const turnstileWidgetPropertiesSchema: z.ZodType<TurnstileWidgetProperties> = z.object({
  widgetName: z.string(),
  domains: z.array(z.string()),
  mode: z.enum(['non-interactive', 'invisible', 'managed']),
  botFightMode: z.boolean().optional(),
  clearanceLevel: z.enum(['no_clearance', 'jschallenge', 'managed', 'interactive']).optional(),
  ephemeralId: z.boolean().optional(),
  offlabel: z.boolean().optional(),
  region: z.enum(['world', 'china']).optional(),
});

function normalize(p: TurnstileWidgetProperties): unknown {
  return {
    widgetName: p.widgetName,
    domains: [...p.domains].sort(),
    mode: p.mode,
    botFightMode: p.botFightMode ?? false,
    clearanceLevel: p.clearanceLevel ?? 'no_clearance',
    ephemeralId: p.ephemeralId ?? false,
    offlabel: p.offlabel ?? false,
    region: p.region ?? 'world',
  };
}

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const turnstileWidgetProvider: CloudflareResourceProvider<TurnstileWidgetProperties> = {
  resourceType: 'TurnstileWidget',
  schema: turnstileWidgetPropertiesSchema,
  equals: makeEquals<TurnstileWidgetProperties>(normalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    try {
      const page = await ctx.cloudflare.turnstile.widgets.list({ account_id: ctx.accountId });
      for await (const w of page) {
        const label = parseLabel(w.name);
        if (label === null) continue;
        if (typeof w.sitekey !== 'string') continue;
        yield { nativeId: w.sitekey, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const w = await ctx.cloudflare.turnstile.widgets.get(nativeId, {
        account_id: ctx.accountId,
      });
      return {
        widgetName: w.name ?? '',
        domains: w.domains ?? [],
        mode: w.mode as TurnstileMode,
        ...(w.bot_fight_mode !== undefined ? { botFightMode: w.bot_fight_mode } : {}),
        ...(w.clearance_level !== undefined
          ? { clearanceLevel: w.clearance_level as TurnstileClearanceLevel }
          : {}),
        ...(w.ephemeral_id !== undefined ? { ephemeralId: w.ephemeral_id } : {}),
        ...(w.offlabel !== undefined ? { offlabel: w.offlabel } : {}),
        ...(w.region !== undefined ? { region: w.region as TurnstileRegion } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const w = await ctx.cloudflare.turnstile.widgets.create({
        account_id: ctx.accountId,
        name: desired.widgetName,
        domains: [...desired.domains],
        mode: desired.mode,
        ...(desired.botFightMode !== undefined ? { bot_fight_mode: desired.botFightMode } : {}),
        ...(desired.clearanceLevel !== undefined
          ? { clearance_level: desired.clearanceLevel }
          : {}),
        ...(desired.ephemeralId !== undefined ? { ephemeral_id: desired.ephemeralId } : {}),
        ...(desired.offlabel !== undefined ? { offlabel: desired.offlabel } : {}),
        ...(desired.region !== undefined ? { region: desired.region } : {}),
      });
      const sitekey = (w as { sitekey?: string }).sitekey ?? '';
      return { kind: 'sync', nativeId: sitekey, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.turnstile.widgets.update(nativeId, {
        account_id: ctx.accountId,
        name: desired.widgetName,
        domains: [...desired.domains],
        mode: desired.mode,
        ...(desired.botFightMode !== undefined ? { bot_fight_mode: desired.botFightMode } : {}),
        ...(desired.clearanceLevel !== undefined
          ? { clearance_level: desired.clearanceLevel }
          : {}),
        ...(desired.ephemeralId !== undefined ? { ephemeral_id: desired.ephemeralId } : {}),
        ...(desired.offlabel !== undefined ? { offlabel: desired.offlabel } : {}),
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.turnstile.widgets.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
