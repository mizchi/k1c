import { describe, it, expect } from 'vitest';
import { placeholder, parsePlaceholder, isPlaceholder } from './placeholders.ts';

describe('placeholders', () => {
  it('round-trips resourceType + label through placeholder / parsePlaceholder', () => {
    const s = placeholder('KVNamespace', 'default/cache');
    expect(s).toBe('<resolved-at-apply:KVNamespace:default/cache>');
    expect(parsePlaceholder(s)).toEqual({ resourceType: 'KVNamespace', label: 'default/cache' });
  });

  it('parsePlaceholder returns null for non-strings and unrelated strings', () => {
    expect(parsePlaceholder(42)).toBeNull();
    expect(parsePlaceholder(undefined)).toBeNull();
    expect(parsePlaceholder('plain string')).toBeNull();
    expect(parsePlaceholder('<resolved-at-apply:>')).toBeNull();
    expect(parsePlaceholder('<resolved-at-apply:foo>')).toBeNull(); // missing colon
    expect(parsePlaceholder('<resolved-at-apply::label>')).toBeNull(); // empty type
  });

  it('parsePlaceholder accepts labels containing colons after the first separator', () => {
    expect(parsePlaceholder('<resolved-at-apply:Type:ns/has:colon>')).toEqual({
      resourceType: 'Type',
      label: 'ns/has:colon',
    });
  });

  it('isPlaceholder mirrors parsePlaceholder !== null', () => {
    expect(isPlaceholder('<resolved-at-apply:T:l>')).toBe(true);
    expect(isPlaceholder('not a placeholder')).toBe(false);
  });
});
