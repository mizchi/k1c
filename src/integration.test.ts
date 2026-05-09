import { describe, it, expect } from 'vitest';
import { parseManifest } from './manifest/parse.ts';
import { lower } from './manifest/lower.ts';
import { plan } from './reconciler/plan.ts';
import { apply } from './reconciler/apply.ts';
import { FakeProvider, makeFakeContext } from './reconciler/fake-provider.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { workerSchema } from './providers/worker.ts';
import { r2BucketSchema } from './providers/r2-bucket.ts';
import { kvNamespaceSchema } from './providers/kv-namespace.ts';

function buildRegistry() {
  const worker = new FakeProvider('Worker', workerSchema);
  const r2 = new FakeProvider('R2Bucket', r2BucketSchema);
  const kv = new FakeProvider('KVNamespace', kvNamespaceSchema);
  const registry = new ProviderRegistry();
  registry.register(worker);
  registry.register(r2);
  registry.register(kv);
  return { worker, r2, kv, registry };
}

const SAMPLE = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: { location: weur }
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
spec: {}
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg }
data:
  LOG_LEVEL: info
---
apiVersion: v1
kind: Secret
metadata: { name: creds }
stringData:
  TOKEN: t0p_s3cret
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/compatibility-date: "2025-06-01"
    cloudflare.com/observability: enabled
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          env:
            - { name: REGION, value: weur }
            - name: LOG_LEVEL
              valueFrom: { configMapKeyRef: { name: cfg, key: LOG_LEVEL } }
            - name: TOKEN
              valueFrom: { secretKeyRef: { name: creds, key: TOKEN } }
          volumeMounts:
            - { name: r2-media, mountPath: /mnt/r2-media }
            - { name: kv-cache, mountPath: /mnt/kv-cache }
      volumes:
        - name: r2-media
          csi:
            driver: r2.k1c.io
            volumeAttributes: { bucketRef: media }
        - name: kv-cache
          csi:
            driver: kv.k1c.io
            volumeAttributes: { namespaceRef: cache }
`;

describe('integration: parse → lower → plan → apply', () => {
  it('applies a fresh manifest and creates all resources', async () => {
    const { worker, r2, kv, registry } = buildRegistry();
    const ctx = makeFakeContext();

    const parsed = parseManifest(SAMPLE);
    expect(parsed.resources).toHaveLength(5);

    const lowered = await lower(parsed.resources, { readFile: async (p) => new TextEncoder().encode(`// stub for ${p}`) });
    expect(lowered.desired).toHaveLength(3); // R2Bucket, KVNamespace, Worker

    const p = await plan(lowered.desired, registry, ctx);
    const kinds = p.operations.map((o) => o.kind).sort();
    expect(kinds).toEqual(['create', 'create', 'create']);

    const report = await apply(p, registry, ctx);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);

    expect(r2.state.size).toBe(1);
    expect(kv.state.size).toBe(1);
    expect(worker.state.size).toBe(1);

    const workerState = [...worker.state.values()][0]!;
    expect(workerState.label).toBe('default/api');
    const props = workerState.properties as unknown as Record<string, unknown>;
    expect(props.scriptName).toBe('k1c--default--api');
    expect(props.compatibilityDate).toBe('2025-06-01');
    expect(props.vars).toEqual({ REGION: 'weur', LOG_LEVEL: 'info' });
    expect(props.secrets).toEqual({ TOKEN: 't0p_s3cret' });
    expect(props.observability).toEqual({ enabled: true });
    const bindings = props.bindings as Array<Record<string, string>>;
    expect(bindings).toHaveLength(2);
    expect(bindings.find((b) => b.type === 'r2_bucket')).toMatchObject({
      name: 'R2_MEDIA',
      bucketName: 'k1c-default-media',
    });
  });

  it('subsequent apply with unchanged manifest produces only noops', async () => {
    const { registry } = buildRegistry();
    const ctx = makeFakeContext();

    const parsed = parseManifest(SAMPLE);
    const lowered = await lower(parsed.resources, { readFile: async (p) => new TextEncoder().encode(`// stub for ${p}`) });
    await apply(await plan(lowered.desired, registry, ctx), registry, ctx);

    // re-apply
    const p2 = await plan(lowered.desired, registry, ctx);
    expect(p2.operations.every((o) => o.kind === 'noop')).toBe(true);
    const report2 = await apply(p2, registry, ctx);
    expect(report2.succeeded).toBe(3);
    expect(report2.failed).toBe(0);
  });

  it('removing a resource from manifest causes it to be deleted', async () => {
    const { worker, r2, kv, registry } = buildRegistry();
    const ctx = makeFakeContext();

    const parsed = parseManifest(SAMPLE);
    const lowered = await lower(parsed.resources, { readFile: async (p) => new TextEncoder().encode(`// stub for ${p}`) });
    await apply(await plan(lowered.desired, registry, ctx), registry, ctx);

    // Reduce the manifest to just the R2Bucket — Deployment is gone, KVNamespace is gone.
    // (Removing only KVNamespace would fail to lower because the Deployment still refers to it.)
    const smaller = parseManifest(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: { location: weur }
`);
    const lowered2 = await lower(smaller.resources, { readFile: async (p) => new TextEncoder().encode(`// stub for ${p}`) });
    const p2 = await plan(lowered2.desired, registry, ctx);
    const kinds = p2.operations.map((o) => o.kind).sort();
    // expect: noop(R2), delete(KV), delete(Worker)
    expect(kinds).toEqual(['delete', 'delete', 'noop']);
    const report = await apply(p2, registry, ctx);
    expect(report.failed).toBe(0);
    expect(r2.state.size).toBe(1);
    expect(kv.state.size).toBe(0);
    expect(worker.state.size).toBe(0);
  });
});
