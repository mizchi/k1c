import { describe, it, expect } from 'vitest';
import { lower, LowerError } from './lower.ts';
import { parseManifest } from './parse.ts';

function lowerYaml(yaml: string) {
  const { resources } = parseManifest(yaml);
  return lower(resources);
}

describe('lower', () => {
  it('returns empty desired list for empty input', () => {
    expect(lower([]).desired).toHaveLength(0);
  });

  it('skips Namespace resources', () => {
    const result = lowerYaml(`
apiVersion: v1
kind: Namespace
metadata: { name: prod }
`);
    expect(result.desired).toHaveLength(0);
  });

  it('lowers R2Bucket to a DesiredResource with prefixed bucket name', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media, namespace: prod }
spec: { location: weur }
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('R2Bucket');
    expect(d.label).toBe('prod/media');
    expect(d.properties).toEqual({ bucketName: 'k1c-prod-media', location: 'weur' });
  });

  it('lowers DispatchNamespace to a DesiredResource with prefixed name', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DispatchNamespace
metadata: { name: production, namespace: prod }
spec: {}
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('DispatchNamespace');
    expect(d.label).toBe('prod/production');
    expect(d.properties).toEqual({ namespaceName: 'k1c-prod-production' });
  });

  it('lowers KVNamespace to a DesiredResource with prefixed title', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
spec: {}
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('KVNamespace');
    expect(d.properties).toEqual({ title: 'k1c/default/cache' });
  });

  it('lowers a minimal Deployment to a Worker with defaults', () => {
    const result = lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('Worker');
    expect(d.label).toBe('default/api');
    expect(d.properties).toMatchObject({
      scriptName: 'k1c--default--api',
      entrypoint: './dist/worker.js',
      compatibilityDate: '2025-01-01',
    });
    expect(d.dependsOn ?? []).toHaveLength(0);
  });

  it('honours cloudflare.com/* annotations on Deployment', () => {
    const result = lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/compatibility-date: "2025-06-01"
    cloudflare.com/compatibility-flags: "nodejs_compat, streams_enable_constructors"
    cloudflare.com/observability: enabled
    cloudflare.com/smart-placement: smart
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.compatibilityDate).toBe('2025-06-01');
    expect(props.compatibilityFlags).toEqual(['nodejs_compat', 'streams_enable_constructors']);
    expect(props.observability).toEqual({ enabled: true });
    expect(props.placement).toEqual({ mode: 'smart' });
  });

  it('inlines literal env values into Worker.vars', () => {
    const result = lowerYaml(`
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
          env:
            - { name: LOG_LEVEL, value: info }
            - { name: REGION, value: weur }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.vars).toEqual({ LOG_LEVEL: 'info', REGION: 'weur' });
  });

  it('resolves env from ConfigMap and records dependency', () => {
    const result = lowerYaml(`
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg }
data:
  LOG_LEVEL: debug
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
          env:
            - name: LOG_LEVEL
              valueFrom:
                configMapKeyRef: { name: cfg, key: LOG_LEVEL }
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    expect(props.vars).toEqual({ LOG_LEVEL: 'debug' });
    expect(worker.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'ConfigMap', name: 'cfg' }),
    );
  });

  it('resolves env from Secret stringData and records dependency', () => {
    const result = lowerYaml(`
apiVersion: v1
kind: Secret
metadata: { name: creds }
stringData:
  TOKEN: abc123
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
          env:
            - name: TOKEN
              valueFrom:
                secretKeyRef: { name: creds, key: TOKEN }
`);
    const worker = result.desired[0]!;
    const props = worker.properties as Record<string, unknown>;
    expect(props.secrets).toEqual({ TOKEN: 'abc123' });
    expect(worker.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Secret', name: 'creds' }),
    );
  });

  it('decodes Secret base64 data field', () => {
    const result = lowerYaml(`
apiVersion: v1
kind: Secret
metadata: { name: creds }
data:
  TOKEN: YWJjMTIz
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
          env:
            - name: TOKEN
              valueFrom:
                secretKeyRef: { name: creds, key: TOKEN }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.secrets).toEqual({ TOKEN: 'abc123' });
  });

  it('emits r2_bucket binding from volume + volumeMount', () => {
    const result = lowerYaml(`
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
        - name: bucket
          r2BucketRef: { name: media }
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    expect(props.bindings).toEqual([
      { type: 'r2_bucket', name: 'R2_MEDIA', bucketName: 'k1c-default-media' },
    ]);
    expect(worker.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'R2Bucket', name: 'media' }),
    );
  });

  it('emits kv_namespace binding with placeholder namespaceId', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
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
            - { name: kv, mountPath: KV_CACHE }
      volumes:
        - name: kv
          kvNamespaceRef: { name: cache }
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    const bindings = props.bindings as Array<Record<string, string>>;
    expect(bindings[0]).toMatchObject({
      type: 'kv_namespace',
      name: 'KV_CACHE',
    });
    expect(bindings[0]?.namespaceId).toMatch(/cache/);
  });

  it('throws LowerError when ConfigMap reference is unresolved', () => {
    const yaml = `
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
          env:
            - name: X
              valueFrom:
                configMapKeyRef: { name: missing, key: X }
`;
    expect(() => lowerYaml(yaml)).toThrow(LowerError);
    expect(() => lowerYaml(yaml)).toThrow(/ConfigMap.*missing/);
  });

  it('throws LowerError when Secret key is missing on a found Secret', () => {
    const yaml = `
apiVersion: v1
kind: Secret
metadata: { name: creds }
stringData: { OTHER: y }
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
          env:
            - name: TOKEN
              valueFrom:
                secretKeyRef: { name: creds, key: TOKEN }
`;
    expect(() => lowerYaml(yaml)).toThrow(/Secret.*creds.*TOKEN/);
  });

  it('throws when volumeMount has no matching volume', () => {
    const yaml = `
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
            - { name: missing, mountPath: X }
`;
    expect(() => lowerYaml(yaml)).toThrow(/volumeMount.*missing/);
  });

  it('throws when Deployment has multiple containers (v0 limitation)', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: a, image: ./a.js }
        - { name: b, image: ./b.js }
`;
    expect(() => lowerYaml(yaml)).toThrow(/single-container/);
  });

  it('rejects cross-namespace ConfigMap reference', () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg, namespace: other }
data: { X: y }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: prod }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          env:
            - name: X
              valueFrom:
                configMapKeyRef: { name: cfg, key: X }
`;
    // ConfigMap is in 'other', Deployment looks in 'prod' — should fail to resolve
    expect(() => lowerYaml(yaml)).toThrow(/ConfigMap.*cfg/);
  });

  it('lowers Rollout (blueGreen) into a Worker with no warnings', () => {
    const result = lowerYaml(`
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
  strategy:
    blueGreen:
      autoPromotionEnabled: true
`);
    expect(result.warnings).toHaveLength(0);
    const w = result.desired[0]!;
    expect(w.resourceType).toBe('Worker');
    expect(w.ref.kind).toBe('Rollout');
    expect(w.label).toBe('default/api');
    expect((w.properties as Record<string, unknown>).scriptName).toBe('k1c--default--api');
  });

  it('lowers Rollout with cloudflare.com/dispatch-namespace into dispatcher + stable + state KV', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DispatchNamespace
metadata: { name: production }
spec: {}
---
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api
  annotations:
    cloudflare.com/dispatch-namespace: production
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./dist/worker.js }]
  strategy:
    canary:
      steps:
        - { setWeight: 10 }
        - { setWeight: 100 }
`);

    // dispatch namespace + state kv + stable + dispatcher = 4 desired
    expect(result.desired).toHaveLength(4);

    const stable = result.desired.find((d) => d.label === 'default/api--stable');
    expect(stable).toBeDefined();
    const stableProps = stable!.properties as Record<string, unknown>;
    expect(stableProps.scriptName).toBe('k1c--default--api--stable');
    expect(stableProps.dispatchNamespace).toBe('k1c-default-production');

    const dispatcher = result.desired.find(
      (d) => d.label === 'default/api' && d.resourceType === 'Worker',
    );
    expect(dispatcher).toBeDefined();
    const dispatcherProps = dispatcher!.properties as Record<string, unknown>;
    expect(dispatcherProps.scriptName).toBe('k1c--default--api');
    expect(dispatcherProps.dispatchNamespace).toBeUndefined();
    expect(dispatcherProps.entrypointContent).toContain('k1c--default--api--stable');
    expect(dispatcherProps.entrypointContent).toContain('k1c--default--api--canary');
    const bindings = dispatcherProps.bindings as Array<Record<string, string>>;
    expect(bindings).toContainEqual(
      expect.objectContaining({
        type: 'dispatch_namespace',
        name: 'NAMESPACE',
        dispatchNamespace: 'k1c-default-production',
      }),
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({ type: 'kv_namespace', name: 'STATE' }),
    );
    expect(dispatcher!.dependsOn).toBeDefined();

    const stateKv = result.desired.find(
      (d) => d.resourceType === 'KVNamespace' && d.label.includes('rollout-state'),
    );
    expect(stateKv).toBeDefined();
    expect((stateKv!.properties as Record<string, unknown>).title).toBe(
      'k1c/rollout-state/production',
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/canary state machine.*not yet implemented/);
  });

  it('does not duplicate the rollout-state KV when multiple Rollouts share a dispatch namespace', () => {
    const result = lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DispatchNamespace
metadata: { name: prod }
spec: {}
---
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-a
  annotations: { cloudflare.com/dispatch-namespace: prod }
spec:
  selector: { matchLabels: { app: a } }
  template:
    spec:
      containers: [{ name: a, image: ./a.js }]
  strategy: { blueGreen: { autoPromotionEnabled: true } }
---
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-b
  annotations: { cloudflare.com/dispatch-namespace: prod }
spec:
  selector: { matchLabels: { app: b } }
  template:
    spec:
      containers: [{ name: b, image: ./b.js }]
  strategy: { blueGreen: { autoPromotionEnabled: true } }
`);
    const stateKvs = result.desired.filter(
      (d) => d.resourceType === 'KVNamespace' && d.label.includes('rollout-state'),
    );
    expect(stateKvs).toHaveLength(1);
  });

  it('warns when Rollout uses canary strategy (not yet implemented)', () => {
    const result = lowerYaml(`
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
  strategy:
    canary:
      steps:
        - { setWeight: 10 }
        - { pause: { duration: 5m } }
        - { setWeight: 100 }
`);
    expect(result.desired).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/canary.*not yet implemented/i);
  });

  it('warns when Rollout disables auto-promotion (not yet implemented)', () => {
    const result = lowerYaml(`
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
  strategy:
    blueGreen:
      autoPromotionEnabled: false
`);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/autoPromotionEnabled=false.*not yet implemented/i);
  });

  it('does not duplicate dependsOn entries when one resource is referenced twice', () => {
    const result = lowerYaml(`
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg }
data:
  A: '1'
  B: '2'
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
          env:
            - { name: A, valueFrom: { configMapKeyRef: { name: cfg, key: A } } }
            - { name: B, valueFrom: { configMapKeyRef: { name: cfg, key: B } } }
`);
    const worker = result.desired[0]!;
    const cmDeps = (worker.dependsOn ?? []).filter((r) => r.kind === 'ConfigMap');
    expect(cmDeps).toHaveLength(1);
  });
});
