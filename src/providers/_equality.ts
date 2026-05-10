/**
 * Shared helpers for provider-level equality checks.
 *
 * Several providers normalize Cloudflare-side default values (e.g.
 * `proxied: false`, `storage_class: 'Standard'`, `recording.mode: 'off'`)
 * before comparison so re-applying an unchanged manifest doesn't flag
 * spurious drift. Each of those providers also needs an order-stable
 * JSON serializer because vanilla `JSON.stringify` is sensitive to
 * object-key ordering — and Cloudflare's API order rarely matches the
 * manifest's. This module collects the helper so the providers don't
 * each ship their own copy.
 */

/**
 * Deterministic JSON serialization: object keys are sorted at every
 * level, so `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 * Arrays are NOT reordered — the caller is responsible for sorting
 * arrays whose order isn't load-bearing (e.g. Worker bindings).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Build a `provider.equals` callback from a normalize function.
 *
 *   const equals = makeEquals<MyProps>((p) => ({
 *     name: p.name,
 *     enabled: p.enabled ?? true,           // CF default
 *     tags: [...p.tags].sort(),             // set-like
 *   }));
 *
 * The normalize function strips defaults / sorts arrays / drops
 * write-only fields; the resulting callback compares two normalized
 * properties via stableStringify.
 */
export function makeEquals<P>(normalize: (p: P) => unknown): (prior: P, desired: P) => boolean {
  return (prior, desired) => stableStringify(normalize(prior)) === stableStringify(normalize(desired));
}
