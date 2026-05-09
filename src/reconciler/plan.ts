import type { ProviderContext } from '../providers/types.ts';
import { NotFound } from '../providers/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { DesiredResource, Operation, Plan } from './types.ts';
import { namespaceFromLabel } from './types.ts';
import { refKey } from '../manifest/types.ts';
import { topoSort } from './topo.ts';
import { cacheKey, resolveValue, type ResolutionCache } from './resolve.ts';

export async function plan(
  desired: ReadonlyArray<DesiredResource>,
  registry: ProviderRegistry,
  ctx: ProviderContext,
): Promise<Plan> {
  const desiredNamespaces = new Set<string>();
  const desiredByType = new Map<string, DesiredResource[]>();
  for (const d of desired) {
    desiredNamespaces.add(d.ref.namespace);
    const arr = desiredByType.get(d.resourceType) ?? [];
    arr.push(d);
    desiredByType.set(d.resourceType, arr);
  }

  const operations: Operation[] = [];

  // Pre-pass: list every registered provider once and seed the resolution
  // cache with `resourceType:label → nativeId`. The same cache is used to
  // substitute `<resolved-at-apply:...>` placeholders in desired properties
  // before they are compared to prior state, so an unchanged manifest does
  // not look "drifted" just because lower emits placeholders that the
  // provider already serialized as concrete IDs.
  const actualsByType = new Map<string, Map<string, { nativeId: string; label: string }>>();
  const resolutionCache: ResolutionCache = new Map();
  for (const resourceType of registry.types()) {
    const provider = registry.get(resourceType);
    const actualByLabel = new Map<string, { nativeId: string; label: string }>();
    for await (const item of provider.list(ctx)) {
      actualByLabel.set(item.label, item);
      resolutionCache.set(cacheKey(resourceType, item.label), item.nativeId);
    }
    actualsByType.set(resourceType, actualByLabel);
  }

  for (const resourceType of registry.types()) {
    const provider = registry.get(resourceType);
    const desiredOfType = desiredByType.get(resourceType) ?? [];
    const desiredByLabel = new Map<string, DesiredResource>();
    for (const d of desiredOfType) desiredByLabel.set(d.label, d);
    const actualByLabel = actualsByType.get(resourceType)!;

    for (const d of desiredOfType) {
      // Resolve placeholders against the actuals listed above. New resources
      // (no actual yet) leave their placeholders intact; apply.ts will resolve
      // them after their dependencies are created in the same run.
      const resolvedProps = await resolveValueQuietly(d.properties, registry, ctx, resolutionCache);

      const actual = actualByLabel.get(d.label);
      if (!actual) {
        operations.push({
          kind: 'create',
          resourceType,
          ref: d.ref,
          label: d.label,
          properties: resolvedProps,
        });
        continue;
      }
      const prior = await provider.read(ctx, actual.nativeId);
      if (prior === NotFound) {
        operations.push({
          kind: 'create',
          resourceType,
          ref: d.ref,
          label: d.label,
          properties: resolvedProps,
        });
        continue;
      }
      const equal = provider.equals
          ? provider.equals(prior, resolvedProps as never)
          : propertiesEqual(prior, resolvedProps);
      if (equal) {
        operations.push({
          kind: 'noop',
          resourceType,
          ref: d.ref,
          label: d.label,
        });
      } else {
        operations.push({
          kind: 'update',
          resourceType,
          ref: d.ref,
          label: d.label,
          nativeId: actual.nativeId,
          prior,
          properties: resolvedProps,
        });
      }
    }

    for (const [label, actual] of actualByLabel) {
      if (desiredByLabel.has(label)) continue;
      if (!desiredNamespaces.has(namespaceFromLabel(label))) continue;
      operations.push({
        kind: 'delete',
        resourceType,
        nativeId: actual.nativeId,
        label,
      });
    }
  }

  return { operations: orderByDependencies(operations, desired) };
}

/**
 * Best-effort resolution: unlike `resolveValue` in apply, we tolerate misses at
 * plan time because the missing resource may simply not exist yet (it will be
 * created earlier in the same plan run). Apply re-resolves once the dependency
 * has been created, and at that point a miss is a real error.
 */
async function resolveValueQuietly(
  value: unknown,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  cache: ResolutionCache,
): Promise<unknown> {
  try {
    return await resolveValue(value, registry, ctx, cache);
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'NotFound'
    ) {
      return value;
    }
    throw err;
  }
}

function orderByDependencies(
  operations: ReadonlyArray<Operation>,
  desired: ReadonlyArray<DesiredResource>,
): Operation[] {
  const depsByRef = new Map<string, string[]>();
  for (const d of desired) {
    depsByRef.set(refKey(d.ref), (d.dependsOn ?? []).map(refKey));
  }

  type MutatingOp = Extract<Operation, { kind: 'create' | 'update' }>;
  const mutating: MutatingOp[] = [];
  const noops: Operation[] = [];
  const deletes: Operation[] = [];
  for (const op of operations) {
    if (op.kind === 'create' || op.kind === 'update') mutating.push(op);
    else if (op.kind === 'noop') noops.push(op);
    else deletes.push(op);
  }

  const nodes = mutating.map((op) => {
    const id = refKey(op.ref);
    return { id, op, dependsOn: depsByRef.get(id) ?? [] };
  });
  const sortedMutating = topoSort(nodes).map((n) => n.op as Operation);

  noops.sort((a, b) => a.label.localeCompare(b.label));
  deletes.sort((a, b) => {
    const pa = deletePriority(a.resourceType);
    const pb = deletePriority(b.resourceType);
    if (pa !== pb) return pa - pb;
    return a.label.localeCompare(b.label);
  });

  return [...sortedMutating, ...noops, ...deletes];
}

/**
 * Reverse-topological priority for deletes. Smaller priority is deleted first.
 *
 * The reconciler has no per-instance dependency record for resources that are
 * being deleted (they are no longer in `desired`), so we approximate the
 * dependency direction with a static type ordering that mirrors how creates
 * actually flow in `lower.ts`. Workers depend on data services; CustomDomain /
 * Workflow / LogpushJob depend on Workers; DispatchNamespace hosts Workers.
 *
 * Unknown types fall through with a neutral priority so the sort is still stable.
 */
function deletePriority(resourceType: string): number {
  switch (resourceType) {
    // Top-level edges — nothing else points at these. Delete first so we do not
    // serve traffic to a Worker we are about to remove.
    case 'CustomDomain':
    case 'WorkerRoute':
    case 'DNSRecord':
    case 'LogpushJob':
    case 'Workflow':
    case 'AccessApplication':
    case 'CacheRule':
    case 'TransformRule':
    case 'WAFCustomRule':
    case 'RateLimitRule':
    case 'CustomHostname':
    case 'WAFManagedRuleset':
    case 'EmailRoutingRule':
    case 'URIRewriteRule':
    case 'ResponseHeaderRule':
      return 0;
    case 'Worker':
      return 1;
    case 'R2Bucket':
    case 'KVNamespace':
    case 'D1Database':
    case 'Hyperdrive':
    case 'Vectorize':
    case 'Queue':
    case 'AccessPolicy':
      return 2;
    case 'DispatchNamespace':
      return 3;
    default:
      return 1;
  }
}

export function propertiesEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, replacer);
}

function replacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) sorted[k] = (value as Record<string, unknown>)[k];
    return sorted;
  }
  return value;
}
