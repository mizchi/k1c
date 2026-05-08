import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { plan } from './plan.ts';
import { FakeProvider, makeFakeContext } from './fake-provider.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import type { DesiredResource } from './types.ts';
import type { ResourceRef } from '../manifest/types.ts';

interface FooProps {
  readonly value: string;
  readonly extra?: number;
}

const fooSchema = z.object({ value: z.string(), extra: z.number().optional() });

function fooDesired(name: string, props: FooProps, namespace = 'default'): DesiredResource<FooProps> {
  const ref: ResourceRef = {
    apiVersion: 'cloudflare.k1c.io/v1alpha1',
    kind: 'R2Bucket',
    namespace,
    name,
  };
  return {
    resourceType: 'Foo',
    ref,
    label: `${namespace}/${name}`,
    properties: props,
  };
}

function setup() {
  const fooProvider = new FakeProvider('Foo', fooSchema);
  const registry = new ProviderRegistry();
  registry.register(fooProvider);
  const ctx = makeFakeContext();
  return { fooProvider, registry, ctx };
}

describe('plan', () => {
  it('returns empty plan for empty desired and empty actual', async () => {
    const { registry, ctx } = setup();
    const result = await plan([], registry, ctx);
    expect(result.operations).toHaveLength(0);
  });

  it('plans create for new desired resource', async () => {
    const { registry, ctx } = setup();
    const desired = [fooDesired('a', { value: '1' })];
    const result = await plan(desired, registry, ctx);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      kind: 'create',
      resourceType: 'Foo',
      label: 'default/a',
      properties: { value: '1' },
    });
  });

  it('plans noop when actual matches desired', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('native-1', 'default/a', { value: '1' });
    const desired = [fooDesired('a', { value: '1' })];
    const result = await plan(desired, registry, ctx);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ kind: 'noop', label: 'default/a' });
  });

  it('plans update when actual differs from desired', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('native-1', 'default/a', { value: 'old' });
    const desired = [fooDesired('a', { value: 'new' })];
    const result = await plan(desired, registry, ctx);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      kind: 'update',
      nativeId: 'native-1',
      prior: { value: 'old' },
      properties: { value: 'new' },
    });
  });

  it('treats noop as equal regardless of object key order', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('native-1', 'default/a', { value: '1', extra: 7 } as FooProps);
    const desired = [fooDesired('a', { extra: 7, value: '1' } as FooProps)];
    const result = await plan(desired, registry, ctx);
    expect(result.operations[0]?.kind).toBe('noop');
  });

  it('plans delete for actual not in desired (within manifest namespace)', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('native-1', 'default/a', { value: '1' });
    fooProvider.seed('native-2', 'default/orphan', { value: 'x' });
    const desired = [fooDesired('a', { value: '1' })];
    const result = await plan(desired, registry, ctx);
    const kinds = result.operations.map((o) => o.kind).sort();
    expect(kinds).toEqual(['delete', 'noop']);
    const deleteOp = result.operations.find((o) => o.kind === 'delete');
    expect(deleteOp).toMatchObject({ nativeId: 'native-2', label: 'default/orphan' });
  });

  it('does not delete actuals in namespaces absent from manifest', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('native-1', 'prod/a', { value: '1' });
    fooProvider.seed('native-2', 'staging/b', { value: '2' });
    const desired = [fooDesired('a', { value: '1' }, 'prod')];
    const result = await plan(desired, registry, ctx);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.kind).toBe('noop');
  });

  it('handles mix of create + update + delete + noop in one plan', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('id-noop', 'default/keep', { value: 'same' });
    fooProvider.seed('id-update', 'default/change', { value: 'old' });
    fooProvider.seed('id-orphan', 'default/orphan', { value: 'x' });
    const desired = [
      fooDesired('keep', { value: 'same' }),
      fooDesired('change', { value: 'new' }),
      fooDesired('newcomer', { value: 'fresh' }),
    ];
    const result = await plan(desired, registry, ctx);
    const byKind = (kind: string) => result.operations.filter((o) => o.kind === kind);
    expect(byKind('create')).toHaveLength(1);
    expect(byKind('update')).toHaveLength(1);
    expect(byKind('delete')).toHaveLength(1);
    expect(byKind('noop')).toHaveLength(1);
  });

  it('orders dependent creates after their dependencies', async () => {
    const fooProvider = new FakeProvider('Foo', fooSchema);
    const barProvider = new FakeProvider('Bar', fooSchema);
    const registry = new ProviderRegistry();
    registry.register(fooProvider);
    registry.register(barProvider);

    const fooRef = {
      apiVersion: 'cloudflare.k1c.io/v1alpha1',
      kind: 'R2Bucket' as const,
      namespace: 'default',
      name: 'storage',
    };
    const barRef = {
      apiVersion: 'cloudflare.k1c.io/v1alpha1',
      kind: 'R2Bucket' as const,
      namespace: 'default',
      name: 'app',
    };

    const desired: DesiredResource<FooProps>[] = [
      // listed in reverse dependency order on purpose
      { resourceType: 'Bar', ref: barRef, label: 'default/app', properties: { value: 'b' }, dependsOn: [fooRef] },
      { resourceType: 'Foo', ref: fooRef, label: 'default/storage', properties: { value: 'a' } },
    ];

    const result = await plan(desired, registry, makeFakeContext());
    const labels = result.operations.map((o) => o.label);
    expect(labels.indexOf('default/storage')).toBeLessThan(labels.indexOf('default/app'));
  });

  it('places deletes after creates in the plan', async () => {
    const { fooProvider, registry, ctx } = setup();
    fooProvider.seed('id-orphan', 'default/orphan', { value: 'x' });
    const desired = [fooDesired('newcomer', { value: 'n' })];
    const result = await plan(desired, registry, ctx);
    const kinds = result.operations.map((o) => o.kind);
    expect(kinds.indexOf('create')).toBeLessThan(kinds.indexOf('delete'));
  });

  it('treats listed-but-vanished as create (race safety)', async () => {
    const { fooProvider, registry, ctx } = setup();
    // simulate race: list returns it, read says NotFound
    fooProvider.seed('native-ghost', 'default/a', { value: '1' });
    const origRead = fooProvider.read.bind(fooProvider);
    fooProvider.read = async (...args) => {
      // first read returns NotFound
      fooProvider.state.delete('native-ghost');
      return origRead(...args);
    };
    const desired = [fooDesired('a', { value: '1' })];
    const result = await plan(desired, registry, ctx);
    expect(result.operations[0]?.kind).toBe('create');
  });
});
