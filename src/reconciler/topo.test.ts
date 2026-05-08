import { describe, it, expect } from 'vitest';
import { topoSort, CycleError } from './topo.ts';

interface Node {
  readonly id: string;
  readonly dependsOn?: ReadonlyArray<string>;
}

const n = (id: string, deps?: string[]): Node => ({
  id,
  ...(deps !== undefined ? { dependsOn: deps } : {}),
});

describe('topoSort', () => {
  it('returns empty array for empty input', () => {
    expect(topoSort<Node>([])).toEqual([]);
  });

  it('returns a single node unchanged', () => {
    const nodes = [n('a')];
    expect(topoSort(nodes).map((x) => x.id)).toEqual(['a']);
  });

  it('orders a linear chain a → b → c so that deps come first', () => {
    const nodes = [n('c', ['b']), n('a'), n('b', ['a'])];
    expect(topoSort(nodes).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders a diamond a → {b, c} → d', () => {
    // d depends on b and c; b and c depend on a
    const nodes = [n('d', ['b', 'c']), n('b', ['a']), n('c', ['a']), n('a')];
    const result = topoSort(nodes).map((x) => x.id);
    expect(result[0]).toBe('a');
    expect(result[result.length - 1]).toBe('d');
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('d'));
    expect(result.indexOf('c')).toBeLessThan(result.indexOf('d'));
  });

  it('keeps independent nodes in lexicographic order for determinism', () => {
    const nodes = [n('z'), n('a'), n('m')];
    expect(topoSort(nodes).map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });

  it('ignores dependencies on nodes not in the input set', () => {
    const nodes = [n('a', ['external-x']), n('b')];
    const result = topoSort(nodes).map((x) => x.id);
    expect(result.sort()).toEqual(['a', 'b']);
  });

  it('throws CycleError on a 2-cycle', () => {
    const nodes = [n('a', ['b']), n('b', ['a'])];
    expect(() => topoSort(nodes)).toThrow(CycleError);
  });

  it('throws CycleError on a 3-cycle', () => {
    const nodes = [n('a', ['b']), n('b', ['c']), n('c', ['a'])];
    expect(() => topoSort(nodes)).toThrow(CycleError);
  });

  it('CycleError exposes the offending nodes', () => {
    try {
      topoSort([n('a', ['b']), n('b', ['a'])]);
    } catch (e) {
      expect(e).toBeInstanceOf(CycleError);
      expect([...(e as CycleError).cycle].sort()).toEqual(['a', 'b']);
      return;
    }
    expect.fail('expected CycleError');
  });

  it('handles a node depending on itself as a cycle', () => {
    expect(() => topoSort([n('a', ['a'])])).toThrow(CycleError);
  });
});
