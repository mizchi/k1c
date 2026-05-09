/**
 * Placeholder string format used by `lower.ts` for cross-resource ID references.
 *
 * When a Worker binding (or any other property) needs the native Cloudflare ID of a
 * sibling resource (e.g. a KV namespace, D1 database, Hyperdrive config), the
 * lower step does not know that ID — it is assigned at apply time by the
 * provider's `create` call. To bridge the gap the lower step emits a placeholder
 * string in the property; the apply step then walks the desired property tree
 * just before calling `provider.create` / `provider.update` and substitutes the
 * placeholder with the resolved native ID.
 *
 * The placeholder format is intentionally simple and self-describing so callers
 * outside this file (tests, debug output) can recognize it on sight:
 *
 *   <resolved-at-apply:<resourceType>:<label>>
 *
 *   resourceType  the registry key of the provider that owns the resource
 *                 (e.g. "KVNamespace", "D1Database", "Hyperdrive")
 *   label         the resource's k1c label, normally `<namespace>/<name>`
 */

const PREFIX = '<resolved-at-apply:';
const SUFFIX = '>';

export function placeholder(resourceType: string, label: string): string {
  return `${PREFIX}${resourceType}:${label}${SUFFIX}`;
}

export interface ParsedPlaceholder {
  readonly resourceType: string;
  readonly label: string;
}

export function parsePlaceholder(value: unknown): ParsedPlaceholder | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(PREFIX) || !value.endsWith(SUFFIX)) return null;
  const inner = value.slice(PREFIX.length, value.length - SUFFIX.length);
  const colon = inner.indexOf(':');
  if (colon <= 0 || colon === inner.length - 1) return null;
  return { resourceType: inner.slice(0, colon), label: inner.slice(colon + 1) };
}

export function isPlaceholder(value: unknown): boolean {
  return parsePlaceholder(value) !== null;
}
