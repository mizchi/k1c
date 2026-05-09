import { describe, it, expect } from 'vitest';
import { runApply, runDelete, runDescribe, runDiff, runGet } from './run.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { workerSchema } from '../providers/worker.ts';
import { r2BucketSchema } from '../providers/r2-bucket.ts';
import { kvNamespaceSchema } from '../providers/kv-namespace.ts';
import { FakeProvider, makeFakeContext } from '../reconciler/fake-provider.ts';
import type { ProviderError } from '../providers/types.ts';

const MANIFEST = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          volumeMounts:
            - { name: bucket, mountPath: R2_MEDIA }
      volumes:
        - { name: bucket, r2BucketRef: { name: media } }
`;

function buildDeps(manifest: string = MANIFEST) {
  const worker = new FakeProvider('Worker', workerSchema);
  const r2 = new FakeProvider('R2Bucket', r2BucketSchema);
  const kv = new FakeProvider('KVNamespace', kvNamespaceSchema);
  const registry = new ProviderRegistry();
  registry.register(worker);
  registry.register(r2);
  registry.register(kv);
  const out: string[] = [];
  const err: string[] = [];
  return {
    worker,
    r2,
    kv,
    registry,
    providerCtx: makeFakeContext(),
    readManifest: async () => manifest,
    out: (m: string) => out.push(m),
    err: (m: string) => err.push(m),
    captured: { out, err },
  };
}

describe('runApply', () => {
  it('returns 0 and creates resources on a fresh manifest', async () => {
    const deps = buildDeps();
    const code = await runApply({ kind: 'apply', file: 'm.yaml', dryRun: false, watch: false, quiet: false }, deps);
    expect(code).toBe(0);
    expect(deps.r2.state.size).toBe(1);
    expect(deps.worker.state.size).toBe(1);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/CREATE\s+R2Bucket\s+default\/media/);
    expect(printed).toMatch(/CREATE\s+Worker\s+default\/api/);
    expect(printed).toMatch(/summary: 2 ok/);
  });

  it('returns 0 and makes no provider calls in dry-run', async () => {
    const deps = buildDeps();
    const eventsBefore =
      deps.r2.events.length + deps.worker.events.length + deps.kv.events.length;
    const code = await runApply({ kind: 'apply', file: 'm.yaml', dryRun: true, watch: false, quiet: false }, deps);
    expect(code).toBe(0);
    const eventsAfter =
      deps.r2.events.length + deps.worker.events.length + deps.kv.events.length;
    // Plan still calls list/read on providers; new mutating events should not happen.
    const newEvents = eventsAfter - eventsBefore;
    const writeOps = ['create', 'update', 'delete'];
    const newWrites = [...deps.r2.events, ...deps.worker.events, ...deps.kv.events]
      .slice(eventsBefore - newEvents)
      .filter((e) => writeOps.includes(e.op));
    expect(newWrites).toHaveLength(0);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/dry-run/i);
  });

  it('returns non-zero exit code when an operation fails', async () => {
    const deps = buildDeps();
    const err: ProviderError = { code: 'AccessDenied', recoverable: false, message: 'forbidden' };
    deps.worker.injectFailure({ op: 'create', remaining: 99, error: err });
    const code = await runApply({ kind: 'apply', file: 'm.yaml', dryRun: false, watch: false, quiet: false }, deps);
    expect(code).not.toBe(0);
    const printedErr = deps.captured.out.join('\n') + deps.captured.err.join('\n');
    expect(printedErr).toMatch(/FAILED/);
    expect(printedErr).toMatch(/AccessDenied/);
  });

  it('writes parse errors to stderr and returns non-zero', async () => {
    const deps = buildDeps('apiVersion: v1\nkind: Pod\nmetadata: { name: p }\nspec: { containers: [{name: c, image: i}] }\n');
    const code = await runApply({ kind: 'apply', file: 'm.yaml', dryRun: false, watch: false, quiet: false }, deps);
    expect(code).not.toBe(0);
    expect(deps.captured.err.join('\n')).toMatch(/Pod.*not supported/);
  });
});

describe('runDiff', () => {
  it('prints the plan but does not execute any mutations', async () => {
    const deps = buildDeps();
    const eventsBefore =
      deps.r2.events.length + deps.worker.events.length + deps.kv.events.length;
    const code = await runDiff({ kind: 'diff', file: 'm.yaml', output: 'text' }, deps);
    expect(code).toBe(0);
    expect(deps.r2.state.size).toBe(0);
    expect(deps.worker.state.size).toBe(0);
    const writeOps = ['create', 'update', 'delete'];
    const newWrites = [...deps.r2.events, ...deps.worker.events, ...deps.kv.events]
      .slice(eventsBefore)
      .filter((e) => writeOps.includes(e.op));
    expect(newWrites).toHaveLength(0);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/CREATE/);
  });
});

describe('runGet', () => {
  it('lists managed resources of a kind', async () => {
    const deps = buildDeps();
    deps.worker.seed('id-1', 'default/api', { scriptName: 'k1c--default--api' } as never);
    deps.worker.seed('id-2', 'prod/gateway', { scriptName: 'k1c--prod--gateway' } as never);
    const code = await runGet({ kind: 'get', resourceKind: 'Worker', output: 'text' }, deps);
    expect(code).toBe(0);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/default\/api/);
    expect(printed).toMatch(/prod\/gateway/);
  });

  it('filters by namespace', async () => {
    const deps = buildDeps();
    deps.worker.seed('id-1', 'default/api', {} as never);
    deps.worker.seed('id-2', 'prod/gateway', {} as never);
    const code = await runGet(
      { kind: 'get', resourceKind: 'Worker', namespace: 'prod', output: 'text' },
      deps,
    );
    expect(code).toBe(0);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/prod\/gateway/);
    expect(printed).not.toMatch(/default\/api/);
  });

  it('returns 2 for unknown resource kind', async () => {
    const deps = buildDeps();
    const code = await runGet({ kind: 'get', resourceKind: 'Frobnicator', output: 'text' }, deps);
    expect(code).toBe(2);
  });

  it('reports "no resources found" when empty', async () => {
    const deps = buildDeps();
    const code = await runGet({ kind: 'get', resourceKind: 'Worker', output: 'text' }, deps);
    expect(code).toBe(0);
    expect(deps.captured.out.join('\n')).toMatch(/no Worker resources found/);
  });
});

describe('runDescribe', () => {
  it('prints kind / label / nativeId / properties', async () => {
    const deps = buildDeps();
    deps.worker.seed('id-1', 'default/api', {
      scriptName: 'k1c--default--api',
      entrypoint: './w.js',
    } as never);
    const code = await runDescribe(
      { kind: 'describe', resourceKind: 'Worker', name: 'api', output: 'text' },
      deps,
    );
    expect(code).toBe(0);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/Kind:\s+Worker/);
    expect(printed).toMatch(/Label:\s+default\/api/);
    expect(printed).toMatch(/NativeID:\s+id-1/);
    expect(printed).toMatch(/k1c--default--api/);
  });

  it('returns 1 when not found', async () => {
    const deps = buildDeps();
    const code = await runDescribe(
      { kind: 'describe', resourceKind: 'Worker', name: 'ghost', output: 'text' },
      deps,
    );
    expect(code).toBe(1);
  });
});

describe('runDelete', () => {
  it('deletes resources from manifest, skipping data resources without --cascade', async () => {
    const deps = buildDeps();
    deps.worker.seed('w-1', 'default/api', {} as never);
    deps.r2.seed('r-1', 'default/media', {} as never);
    const code = await runDelete(
      { kind: 'delete', file: 'm.yaml', cascade: false },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.worker.state.has('w-1')).toBe(false);
    expect(deps.r2.state.has('r-1')).toBe(true);
    const printed = deps.captured.out.join('\n');
    expect(printed).toMatch(/skipping R2Bucket default\/media/);
    expect(printed).toMatch(/deleted Worker default\/api/);
  });

  it('with --cascade also deletes R2 / KV resources', async () => {
    const deps = buildDeps();
    deps.worker.seed('w-1', 'default/api', {} as never);
    deps.r2.seed('r-1', 'default/media', {} as never);
    const code = await runDelete(
      { kind: 'delete', file: 'm.yaml', cascade: true },
      deps,
    );
    expect(code).toBe(0);
    expect(deps.worker.state.has('w-1')).toBe(false);
    expect(deps.r2.state.has('r-1')).toBe(false);
  });
});
