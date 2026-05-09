import type { ProviderContext } from './types.ts';
import { toProviderError } from './errors.ts';

/**
 * Shared helpers for providers that manage a single rule inside a per-zone,
 * per-phase entrypoint ruleset (CacheRule, TransformRule, WAFCustomRule,
 * RateLimitRule, ...). Each provider owns rules whose `description` field
 * starts with `k1c.io/managed=<label>` and leaves all other rules in the same
 * ruleset untouched.
 */

export const MARKER_PREFIX = 'k1c.io/managed=';

export type RulesetPhase =
  | 'http_request_cache_settings'
  | 'http_request_late_transform'
  | 'http_response_headers_transform'
  | 'http_request_firewall_custom'
  | 'http_request_firewall_managed'
  | 'http_ratelimit';

/**
 * Wire-shape rule. We intentionally type `action_parameters` and `ratelimit` as
 * `unknown` so providers for different phases can specialize without forcing
 * this module to know about every action shape. Each provider casts the field
 * to its own ActionParameters type before reading.
 */
export interface CFRule {
  readonly id?: string;
  readonly action?: string;
  readonly action_parameters?: unknown;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly expression?: string;
  readonly ratelimit?: unknown;
}

interface CFRuleset {
  readonly id?: string;
  readonly rules?: ReadonlyArray<CFRule>;
}

export function buildDescription(label: string, userDescription: string | undefined): string {
  if (userDescription === undefined || userDescription.length === 0) {
    return `${MARKER_PREFIX}${label}`;
  }
  return `${MARKER_PREFIX}${label}: ${userDescription}`;
}

export interface ParsedDescription {
  readonly label: string;
  readonly userDescription?: string;
}

export function parseDescription(description: string | undefined): ParsedDescription | null {
  if (!description?.startsWith(MARKER_PREFIX)) return null;
  const rest = description.slice(MARKER_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return { label: rest.trim() };
  const label = rest.slice(0, colon).trim();
  const userDesc = rest.slice(colon + 1).trim();
  return userDesc.length > 0 ? { label, userDescription: userDesc } : { label };
}

export async function getPhaseRules(
  ctx: ProviderContext,
  zoneId: string,
  phase: RulesetPhase,
): Promise<CFRule[]> {
  try {
    const rs = (await ctx.cloudflare.rulesets.phases.get(phase, {
      zone_id: zoneId,
    })) as CFRuleset;
    return [...(rs.rules ?? [])];
  } catch (raw) {
    const err = toProviderError(raw);
    if (err.code === 'NotFound') return [];
    throw err;
  }
}

export async function putPhaseRules(
  ctx: ProviderContext,
  zoneId: string,
  phase: RulesetPhase,
  rules: ReadonlyArray<CFRule>,
): Promise<CFRule[]> {
  // The SDK's discriminated update params have a per-action arm that does not
  // map cleanly when we want to ferry mixed action shapes through verbatim.
  // The wire format the API actually accepts is "an array of rules" — cast
  // through unknown to silence the over-eager param type.
  const rs = (await ctx.cloudflare.rulesets.phases.update(phase, {
    zone_id: zoneId,
    rules: rules as unknown as never,
  })) as CFRuleset;
  return [...(rs.rules ?? [])];
}
