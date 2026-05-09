import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifestSource } from './cli/manifest-source.ts';
import { parseManifest } from './manifest/parse.ts';
import { lower } from './manifest/lower.ts';

/**
 * What `helm template ./examples/helm-chart` produces with the default values.
 * Pasted here as a literal so the test does not need helm installed; the
 * shape mirrors what helm actually emits, including the leading
 * `# Source:` comment lines that k1c must tolerate.
 */
const HELM_RENDERED = `---
# Source: k1c-hello/templates/r2-bucket.yaml
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata:
  name: media
spec:
  location: weur
---
# Source: k1c-hello/templates/kv-namespace.yaml
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata:
  name: cache
spec: {}
---
# Source: k1c-hello/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hello-config
data:
  GREETING: "hello, k1c-via-helm"
  REGION: "weur"
---
# Source: k1c-hello/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  annotations:
    cloudflare.com/compatibility-date: "2025-09-01"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello
  template:
    spec:
      containers:
        - name: hello
          image: ./examples/hello-worker.mjs
          env:
            - name: GREETING
              valueFrom:
                configMapKeyRef:
                  name: hello-config
                  key: GREETING
            - name: REGION
              valueFrom:
                configMapKeyRef:
                  name: hello-config
                  key: REGION
          volumeMounts:
            - name: bucket
              mountPath: R2_MEDIA
            - name: kv
              mountPath: KV_CACHE
      volumes:
        - name: bucket
          r2BucketRef:
            name: media
        - name: kv
          kvNamespaceRef:
            name: cache
`;

/**
 * What `kustomize build ./examples/kustomize/overlays/prod` would produce: the
 * three base resources plus the extra prod-only bucket, with `namespace: prod`
 * propagated by kustomize's `namespace:` directive and the compatibility-date
 * patched by the JSON-Patch transform.
 */
const KUSTOMIZE_RENDERED = `apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata:
  name: media
  namespace: prod
spec:
  location: weur
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata:
  name: cache
  namespace: prod
spec: {}
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata:
  name: archive
  namespace: prod
spec:
  location: weur
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  namespace: prod
  annotations:
    cloudflare.com/compatibility-date: "2025-12-01"
spec:
  selector:
    matchLabels:
      app: hello
  template:
    spec:
      containers:
        - name: hello
          image: ./examples/hello-worker.mjs
          env:
            - name: REGION
              value: weur
          volumeMounts:
            - name: bucket
              mountPath: R2_MEDIA
            - name: kv
              mountPath: KV_CACHE
      volumes:
        - name: bucket
          r2BucketRef:
            name: media
        - name: kv
          kvNamespaceRef:
            name: cache
`;

const stubReadFile = async (p: string): Promise<Uint8Array> =>
  new TextEncoder().encode(`// stub for ${p}`);

describe('helm template output is parsable + lowerable', () => {
  it('parses a multi-document manifest as helm emits it', () => {
    const result = parseManifest(HELM_RENDERED);
    const kinds = result.resources.map((r) => r.kind).sort();
    expect(kinds).toEqual(['ConfigMap', 'Deployment', 'KVNamespace', 'R2Bucket']);
  });

  it('lowers a helm-rendered Deployment, folding ConfigMap into Worker.vars', async () => {
    const { resources } = parseManifest(HELM_RENDERED);
    const { desired } = await lower(resources, { readFile: stubReadFile });
    const worker = desired.find((d) => d.resourceType === 'Worker' && d.label === 'default/hello');
    expect(worker).toBeDefined();
    const props = worker!.properties as Record<string, unknown>;
    expect(props.vars).toEqual({ GREETING: 'hello, k1c-via-helm', REGION: 'weur' });
    const bindings = props.bindings as Array<Record<string, string>>;
    expect(bindings.find((b) => b.type === 'r2_bucket')).toBeDefined();
    expect(bindings.find((b) => b.type === 'kv_namespace')).toBeDefined();
  });
});

describe('kustomize build output is parsable + lowerable', () => {
  it('honors the namespace: directive across every resource', () => {
    const result = parseManifest(KUSTOMIZE_RENDERED);
    expect(result.resources.every((r) => r.metadata.namespace === 'prod')).toBe(true);
  });

  it('lowers an overlay (extra bucket + patched compatibility date)', async () => {
    const { resources } = parseManifest(KUSTOMIZE_RENDERED);
    const { desired } = await lower(resources, { readFile: stubReadFile });
    const buckets = desired.filter((d) => d.resourceType === 'R2Bucket');
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.label).sort()).toEqual(['prod/archive', 'prod/media']);

    const worker = desired.find((d) => d.resourceType === 'Worker');
    expect(worker!.label).toBe('prod/hello');
    expect((worker!.properties as Record<string, string>).compatibilityDate).toBe('2025-12-01');
  });
});

describe('readManifestSource: stdin / directory plumbing for helm + kustomize pipelines', () => {
  it('round-trips multi-document YAML from a directory of files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'k1c-hk-'));
    try {
      await writeFile(join(work, 'a.yaml'), 'kind: R2Bucket\napiVersion: cloudflare.k1c.io/v1alpha1\nmetadata: { name: a }\nspec: {}\n');
      await writeFile(
        join(work, 'b.yaml'),
        'kind: KVNamespace\napiVersion: cloudflare.k1c.io/v1alpha1\nmetadata: { name: b }\nspec: {}\n',
      );
      const text = await readManifestSource(work);
      const { resources } = parseManifest(text);
      expect(resources.map((r) => r.kind).sort()).toEqual(['KVNamespace', 'R2Bucket']);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('preserves multi-document boundaries when concatenating subdirectory output', async () => {
    const work = await mkdtemp(join(tmpdir(), 'k1c-hk-'));
    try {
      const sub = join(work, 'overlay');
      await mkdir(sub, { recursive: true });
      await writeFile(
        join(work, 'base.yaml'),
        'kind: R2Bucket\napiVersion: cloudflare.k1c.io/v1alpha1\nmetadata: { name: base }\nspec: {}\n',
      );
      await writeFile(
        join(sub, 'overlay.yaml'),
        'kind: KVNamespace\napiVersion: cloudflare.k1c.io/v1alpha1\nmetadata: { name: ov }\nspec: {}\n',
      );
      const text = await readManifestSource(work);
      const { resources } = parseManifest(text);
      expect(resources).toHaveLength(2);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
