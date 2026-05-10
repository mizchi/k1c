import { describe, it, expect } from 'vitest';
import { makeEquals, stableStringify } from './_equality.ts';

describe('stableStringify', () => {
  it('produces identical output for objects with same keys in different order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('keeps arrays in their existing order', () => {
    expect(stableStringify({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}');
  });

  it('sorts keys recursively', () => {
    const a = { outer: { z: 1, a: 2 }, top: 1 };
    const b = { top: 1, outer: { a: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('x')).toBe('"x"');
  });
});

describe('makeEquals', () => {
  it('treats CF-default fields as absent when normalize strips them', () => {
    type P = { readonly enabled?: boolean; readonly name: string };
    const equals = makeEquals<P>((p) => ({ name: p.name, enabled: p.enabled ?? true }));
    expect(equals({ name: 'x', enabled: true }, { name: 'x' })).toBe(true);
    expect(equals({ name: 'x', enabled: false }, { name: 'x' })).toBe(false);
  });

  it('treats arrays as sets when normalize sorts them', () => {
    type P = { readonly tags: ReadonlyArray<string> };
    const equals = makeEquals<P>((p) => ({ tags: [...p.tags].sort() }));
    expect(equals({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBe(true);
  });

  it('returns false on a real difference', () => {
    type P = { readonly v: number };
    const equals = makeEquals<P>((p) => ({ v: p.v }));
    expect(equals({ v: 1 }, { v: 2 })).toBe(false);
  });
});
