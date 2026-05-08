import type { ProviderContext } from '../providers/types.ts';
import { NotFound } from '../providers/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { DesiredResource, Operation, Plan } from './types.ts';
import { namespaceFromLabel } from './types.ts';
import { refKey } from '../manifest/types.ts';
import { topoSort } from './topo.ts';

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

  for (const resourceType of registry.types()) {
    const provider = registry.get(resourceType);
    const desiredOfType = desiredByType.get(resourceType) ?? [];
    const desiredByLabel = new Map<string, DesiredResource>();
    for (const d of desiredOfType) desiredByLabel.set(d.label, d);

    const actualByLabel = new Map<string, { nativeId: string; label: string }>();
    for await (const item of provider.list(ctx)) {
      actualByLabel.set(item.label, item);
    }

    for (const d of desiredOfType) {
      const actual = actualByLabel.get(d.label);
      if (!actual) {
        operations.push({
          kind: 'create',
          resourceType,
          ref: d.ref,
          label: d.label,
          properties: d.properties,
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
          properties: d.properties,
        });
        continue;
      }
      if (propertiesEqual(prior, d.properties)) {
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
          properties: d.properties,
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
  deletes.sort((a, b) => a.label.localeCompare(b.label));

  return [...sortedMutating, ...noops, ...deletes];
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
