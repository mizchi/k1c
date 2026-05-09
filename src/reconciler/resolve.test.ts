import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { resolveValue, type ResolutionCache } from './resolve.ts';
import { placeholder } from './placeholders.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { FakeProvider, makeFakeContext } from './fake-provider.ts';

const fooSchema = z.object({ value: z.string() });

function setup() {
  const provider = new FakeProvider('Foo', fooSchema);
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { provider, registry, ctx: makeFakeContext() };
}

describe('resolveValue', () => {
  it('replaces a placeholder with the cached native id', async () => {
    const { registry, ctx } = setup();
    const cache: ResolutionCache = new Map([['Foo:default/a', 'native-1']]);
    const out = await resolveValue(placeholder('Foo', 'default/a'), registry, ctx, cache);
    expect(out).toBe('native-1');
  });

  it('lists the provider once on cache miss and resolves from the result', async () => {
    const { provider, registry, ctx } = setup();
    provider.seed('native-1', 'default/a', { value: 'x' });
    const cache: ResolutionCache = new Map();
    const out = await resolveValue(placeholder('Foo', 'default/a'), registry, ctx, cache);
    expect(out).toBe('native-1');
    expect(cache.get('Foo:default/a')).toBe('native-1');
  });

  it('walks arrays and nested objects, replacing placeholders in-place', async () => {
    const { registry, ctx } = setup();
    const cache: ResolutionCache = new Map([
      ['Foo:default/a', 'native-a'],
      ['Foo:default/b', 'native-b'],
    ]);
    const input = {
      bindings: [
        { type: 'foo', name: 'A', id: placeholder('Foo', 'default/a') },
        { type: 'foo', name: 'B', id: placeholder('Foo', 'default/b') },
      ],
      meta: { unrelated: 'kept', maybe: placeholder('Foo', 'default/a') },
    };
    const out = (await resolveValue(input, registry, ctx, cache)) as Record<string, unknown>;
    expect(out).toEqual({
      bindings: [
        { type: 'foo', name: 'A', id: 'native-a' },
        { type: 'foo', name: 'B', id: 'native-b' },
      ],
      meta: { unrelated: 'kept', maybe: 'native-a' },
    });
  });

  it('throws a ProviderError-shaped object when the placeholder has no match', async () => {
    const { registry, ctx } = setup();
    const cache: ResolutionCache = new Map();
    await expect(
      resolveValue(placeholder('Foo', 'default/missing'), registry, ctx, cache),
    ).rejects.toMatchObject({ code: 'NotFound' });
  });

  it('passes non-placeholder primitives through unchanged', async () => {
    const { registry, ctx } = setup();
    const cache: ResolutionCache = new Map();
    expect(await resolveValue('plain', registry, ctx, cache)).toBe('plain');
    expect(await resolveValue(42, registry, ctx, cache)).toBe(42);
    expect(await resolveValue(null, registry, ctx, cache)).toBe(null);
  });
});
