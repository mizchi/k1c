import type { ProviderContext } from '../providers/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { parsePlaceholder } from './placeholders.ts';

/**
 * Resolution cache: key = `<resourceType>:<label>`, value = native Cloudflare ID.
 *
 * Populated incrementally by the apply loop (every successful create / update
 * of a resource records its native ID under that resource's label) and lazily
 * by the resolver itself (the first time a placeholder of a given resourceType
 * is encountered the resolver lists that provider and seeds the cache with
 * every entry it finds).
 */
export type ResolutionCache = Map<string, string>;

export function cacheKey(resourceType: string, label: string): string {
  return `${resourceType}:${label}`;
}

/**
 * Walks `value` (typically the `properties` object of a desired Operation)
 * and returns a structurally equal copy with every `<resolved-at-apply:...>`
 * placeholder string replaced by the native ID resolved from the cache.
 *
 * Misses trigger a one-shot list of the placeholder's resource type to
 * populate the cache, after which the lookup is retried. A second miss is
 * surfaced as an error so the apply call site can fail the operation
 * cleanly rather than ferrying a placeholder string into a Cloudflare API
 * payload (which would otherwise produce a confusing 4xx).
 */
export async function resolveValue(
  value: unknown,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  cache: ResolutionCache,
): Promise<unknown> {
  const ph = parsePlaceholder(value);
  if (ph !== null) {
    const key = cacheKey(ph.resourceType, ph.label);
    let resolved = cache.get(key);
    if (resolved === undefined) {
      await populateFromList(ph.resourceType, registry, ctx, cache);
      resolved = cache.get(key);
    }
    if (resolved === undefined) {
      throw {
        code: 'NotFound',
        recoverable: false,
        message: `unable to resolve ${value}: no ${ph.resourceType} with label ${ph.label} found in account`,
      };
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await resolveValue(item, registry, ctx, cache));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveValue(v, registry, ctx, cache);
    }
    return out;
  }
  return value;
}

const populated = new WeakSet<ResolutionCache>();
const populatedTypes = new WeakMap<ResolutionCache, Set<string>>();

async function populateFromList(
  resourceType: string,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  cache: ResolutionCache,
): Promise<void> {
  // Track which provider types we have already listed for this cache so we do
  // not re-issue list calls per binding. The cache itself is per-apply-run, so
  // this scoping naturally resets between runs.
  let seen = populatedTypes.get(cache);
  if (seen === undefined) {
    seen = new Set<string>();
    populatedTypes.set(cache, seen);
    populated.add(cache);
  }
  if (seen.has(resourceType)) return;
  seen.add(resourceType);

  if (!registry.has(resourceType)) return;
  const provider = registry.get(resourceType);
  for await (const item of provider.list(ctx)) {
    const key = cacheKey(resourceType, item.label);
    if (!cache.has(key)) cache.set(key, item.nativeId);
  }
}
