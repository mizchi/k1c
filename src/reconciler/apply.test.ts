import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { apply } from './apply.ts';
import { plan } from './plan.ts';
import { FakeProvider, makeFakeContext } from './fake-provider.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import type { DesiredResource, Operation, Plan } from './types.ts';
import type { ResourceRef } from '../manifest/types.ts';
import type { ProviderError } from '../providers/types.ts';

interface FooProps {
  readonly value: string;
}

const fooSchema = z.object({ value: z.string() });

function fooDesired(name: string, props: FooProps): DesiredResource<FooProps> {
  const ref: ResourceRef = {
    apiVersion: 'cloudflare.k1c.io/v1alpha1',
    kind: 'R2Bucket',
    namespace: 'default',
    name,
  };
  return { resourceType: 'Foo', ref, label: `default/${name}`, properties: props };
}

function setup() {
  const provider = new FakeProvider('Foo', fooSchema);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const ctx = makeFakeContext();
  return { provider, registry, ctx };
}

const recoverable = (code: ProviderError['code']): ProviderError => ({
  code,
  recoverable: true,
  message: `simulated ${code}`,
});

const terminal = (code: ProviderError['code']): ProviderError => ({
  code,
  recoverable: false,
  message: `simulated ${code}`,
});

describe('apply', () => {
  it('reports zero operations for empty plan', async () => {
    const { registry, ctx } = setup();
    const report = await apply({ operations: [] }, registry, ctx);
    expect(report.succeeded).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.results).toHaveLength(0);
  });

  it('executes a create operation and records nativeId', async () => {
    const { provider, registry, ctx } = setup();
    const desired = [fooDesired('a', { value: '1' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(1);
    expect(provider.state.size).toBe(1);
    const created = [...provider.state.values()][0];
    expect(created?.properties).toEqual({ value: '1' });
    expect(report.results[0]?.nativeId).toBeDefined();
  });

  it('executes an update operation', async () => {
    const { provider, registry, ctx } = setup();
    provider.seed('id-1', 'default/a', { value: 'old' });
    const desired = [fooDesired('a', { value: 'new' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(1);
    expect(provider.state.get('id-1')?.properties).toEqual({ value: 'new' });
    expect(provider.events.some((e) => e.op === 'update')).toBe(true);
  });

  it('executes a delete operation', async () => {
    const { provider, registry, ctx } = setup();
    provider.seed('id-1', 'default/keep', { value: 'k' });
    provider.seed('id-2', 'default/orphan', { value: 'o' });
    const desired = [fooDesired('keep', { value: 'k' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(2); // noop + delete
    expect(provider.state.has('id-1')).toBe(true);
    expect(provider.state.has('id-2')).toBe(false);
  });

  it('treats noop as succeeded but makes no provider call beyond list/read', async () => {
    const { provider, registry, ctx } = setup();
    provider.seed('id-1', 'default/a', { value: '1' });
    const desired = [fooDesired('a', { value: '1' })];
    const p = await plan(desired, registry, ctx);
    const eventsBefore = provider.events.length;
    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(1);
    expect(report.skipped).toBe(0);
    expect(provider.events.length).toBe(eventsBefore);
  });

  it('returns failure for terminal provider error and stops further ops by default', async () => {
    const { provider, registry, ctx } = setup();
    provider.injectFailure({ op: 'create', remaining: 99, error: terminal('AccessDenied') });
    const desired = [fooDesired('a', { value: '1' }), fooDesired('b', { value: '2' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx);
    expect(report.failed).toBe(1);
    expect(report.results.some((r) => r.status === 'failed')).toBe(true);
    const failedOp = report.results.find((r) => r.status === 'failed');
    expect(failedOp?.error?.code).toBe('AccessDenied');
  });

  it('retries recoverable errors up to retry budget then succeeds', async () => {
    const { provider, registry, ctx } = setup();
    provider.injectFailure({ op: 'create', remaining: 2, error: recoverable('Throttling') });
    const desired = [fooDesired('a', { value: '1' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx, { retries: 3, backoffMs: 0 });
    expect(report.succeeded).toBe(1);
    expect(provider.state.size).toBe(1);
  });

  it('reports failure when retries exhausted on recoverable error', async () => {
    const { provider, registry, ctx } = setup();
    provider.injectFailure({ op: 'create', remaining: 99, error: recoverable('Throttling') });
    const desired = [fooDesired('a', { value: '1' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx, { retries: 2, backoffMs: 0 });
    expect(report.failed).toBe(1);
    expect(report.results[0]?.error?.code).toBe('Throttling');
  });

  it('does not call provider in dry-run mode', async () => {
    const { provider, registry, ctx } = setup();
    const desired = [fooDesired('a', { value: '1' })];
    const p = await plan(desired, registry, ctx);
    const eventsBefore = provider.events.length;
    const report = await apply(p, registry, ctx, { dryRun: true });
    expect(report.skipped).toBe(1);
    expect(provider.events.length).toBe(eventsBefore);
    expect(provider.state.size).toBe(0);
  });

  it('orders operations: creates before deletes by default', async () => {
    const { provider, registry, ctx } = setup();
    provider.seed('id-orphan', 'default/orphan', { value: 'x' });
    const desired = [fooDesired('newcomer', { value: 'n' })];
    const p = await plan(desired, registry, ctx);
    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(2);
    const opOrder = report.results.map((r) => r.op.kind);
    const createIdx = opOrder.indexOf('create');
    const deleteIdx = opOrder.indexOf('delete');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(createIdx);
  });

  it('substitutes placeholders with native ids of resources created earlier in the run', async () => {
    // Two providers: Foo (the dependency) and Bar (the consumer that holds a
    // <resolved-at-apply:Foo:default/a> placeholder in its property).
    const fooProvider = new FakeProvider('Foo', fooSchema);
    const barProvider = new FakeProvider('Bar', fooSchema);
    const registry = new ProviderRegistry();
    registry.register(fooProvider);
    registry.register(barProvider);
    const ctx = makeFakeContext();

    const fooRef: ResourceRef = {
      apiVersion: 'cloudflare.k1c.io/v1alpha1',
      kind: 'R2Bucket',
      namespace: 'default',
      name: 'a',
    };
    const barRef: ResourceRef = {
      apiVersion: 'cloudflare.k1c.io/v1alpha1',
      kind: 'R2Bucket',
      namespace: 'default',
      name: 'b',
    };

    const customPlan: Plan = {
      operations: [
        {
          kind: 'create',
          resourceType: 'Foo',
          ref: fooRef,
          label: 'default/a',
          properties: { value: 'foo' },
        },
        {
          kind: 'create',
          resourceType: 'Bar',
          ref: barRef,
          label: 'default/b',
          properties: { value: '<resolved-at-apply:Foo:default/a>' },
        },
      ],
    };
    const report = await apply(customPlan, registry, ctx);
    expect(report.succeeded).toBe(2);
    // Bar should have the resolved Foo native id, not the placeholder.
    const barEntry = [...barProvider.state.values()][0]!;
    const fooNativeId = [...fooProvider.state.keys()][0]!;
    expect((barEntry.properties as FooProps).value).toBe(fooNativeId);
  });

  it('fails the operation when a placeholder cannot be resolved', async () => {
    const { registry, ctx } = setup();
    const customPlan: Plan = {
      operations: [
        {
          kind: 'create',
          resourceType: 'Foo',
          ref: {
            apiVersion: 'cloudflare.k1c.io/v1alpha1',
            kind: 'R2Bucket',
            namespace: 'default',
            name: 'b',
          },
          label: 'default/b',
          properties: { value: '<resolved-at-apply:Foo:default/missing>' },
        },
      ],
    };
    const report = await apply(customPlan, registry, ctx);
    expect(report.failed).toBe(1);
    expect(report.results[0]!.status).toBe('failed');
  });

  it('passes plan operations through unchanged when given directly', async () => {
    const { provider, registry, ctx } = setup();
    const op: Operation = {
      kind: 'create',
      resourceType: 'Foo',
      ref: {
        apiVersion: 'cloudflare.k1c.io/v1alpha1',
        kind: 'R2Bucket',
        namespace: 'default',
        name: 'manual',
      },
      label: 'default/manual',
      properties: { value: 'direct' },
    };
    const customPlan: Plan = { operations: [op] };
    const report = await apply(customPlan, registry, ctx);
    expect(report.succeeded).toBe(1);
    expect(provider.state.size).toBe(1);
  });
});
