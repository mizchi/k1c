export interface TopoNode {
  readonly id: string;
  readonly dependsOn?: ReadonlyArray<string>;
}

export class CycleError extends Error {
  readonly cycle: ReadonlyArray<string>;
  constructor(cycle: ReadonlyArray<string>) {
    super(`dependency cycle: ${[...cycle].sort().join(', ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

export function topoSort<T extends TopoNode>(nodes: ReadonlyArray<T>): T[] {
  const byId = new Map<string, T>();
  for (const node of nodes) byId.set(node.id, node);

  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    successors.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      successors.get(dep)!.push(node.id);
    }
  }

  const ready: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id);
  }
  ready.sort();

  const result: T[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(byId.get(id)!);
    const succs = [...(successors.get(id) ?? [])].sort();
    for (const s of succs) {
      const newDeg = (inDegree.get(s) ?? 0) - 1;
      inDegree.set(s, newDeg);
      if (newDeg === 0) ready.push(s);
    }
    ready.sort();
  }

  if (result.length < nodes.length) {
    const resolved = new Set(result.map((n) => n.id));
    const remaining = nodes.filter((n) => !resolved.has(n.id)).map((n) => n.id);
    throw new CycleError(remaining);
  }
  return result;
}
