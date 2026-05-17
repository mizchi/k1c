import { describe, it, expect } from 'vitest';
import { lower, LowerError } from './lower.ts';
import { parseManifest } from './parse.ts';

// Tests inject a deterministic readFile stub so lower can hash entrypoints without
// touching disk. The stub is keyed by path so different entrypoints yield different hashes.
const stubReadFile = async (path: string): Promise<Uint8Array> =>
  new TextEncoder().encode(`// stub for ${path}`);

function lowerYaml(yaml: string) {
  const { resources } = parseManifest(yaml);
  return lower(resources, { readFile: stubReadFile });
}

describe('lower', () => {
  it('returns empty desired list for empty input', async () => {
    expect((await lower([])).desired).toHaveLength(0);
  });

  it('skips Namespace resources', async () => {
    const result = await lowerYaml(`
apiVersion: v1
kind: Namespace
metadata: { name: prod }
`);
    expect(result.desired).toHaveLength(0);
  });

  it('lowers R2Bucket to a DesiredResource with prefixed bucket name', async () => {
    const result = await lowerYaml(`
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

  it('lowers DispatchNamespace to a DesiredResource with prefixed name', async () => {
    const result = await lowerYaml(`
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

  it('lowers AIGateway to a DesiredResource with Cloudflare settings', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AIGateway
metadata: { name: chat, namespace: prod }
spec:
  cacheTtl: 60
  cacheInvalidateOnUpdate: true
  collectLogs: true
  rateLimiting:
    interval: 60
    limit: 120
    technique: sliding
  authentication: true
  logManagement:
    retention: 1000
    strategy: DELETE_OLDEST
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('AIGateway');
    expect(d.label).toBe('prod/chat');
    expect(d.properties).toEqual({
      id: 'k1c-prod-chat',
      cacheTtl: 60,
      cacheInvalidateOnUpdate: true,
      collectLogs: true,
      rateLimiting: { interval: 60, limit: 120, technique: 'sliding' },
      authentication: true,
      logManagement: { retention: 1000, strategy: 'DELETE_OLDEST' },
    });
  });

  it('lowers KVNamespace to a DesiredResource with prefixed title', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
spec: {}
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('KVNamespace');
    expect(d.properties).toEqual({ title: 'k1c/default/cache' });
  });

  it('lowers a minimal Deployment to a Worker with defaults', async () => {
    const result = await lowerYaml(`
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

  it('honours cloudflare.com/* annotations on Deployment', async () => {
    const result = await lowerYaml(`
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

  it('inlines literal env values into Worker.vars', async () => {
    const result = await lowerYaml(`
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

  it('resolves env from ConfigMap and records dependency', async () => {
    const result = await lowerYaml(`
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

  it('resolves env from Secret stringData and records dependency', async () => {
    const result = await lowerYaml(`
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

  it('decodes Secret base64 data field', async () => {
    const result = await lowerYaml(`
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

  it('emits r2_bucket binding from volume + volumeMount', async () => {
    const result = await lowerYaml(`
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
            - { name: r2-media, mountPath: /mnt/r2-media }
      volumes:
        - name: r2-media
          csi:
            driver: r2.k1c.io
            volumeAttributes: { bucketRef: media }
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

  it('honors explicit volumeAttributes.binding before deriving from the volume name', async () => {
    const result = await lowerYaml(`
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
            - { name: r2-media, mountPath: /mnt/media }
      volumes:
        - name: r2-media
          csi:
            driver: r2.k1c.io
            volumeAttributes:
              bucketRef: media
              binding: MEDIA
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    expect(props.bindings).toEqual([
      { type: 'r2_bucket', name: 'MEDIA', bucketName: 'k1c-default-media' },
    ]);
  });

  it('emits kv_namespace binding with placeholder namespaceId', async () => {
    const result = await lowerYaml(`
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
            - { name: kv-cache, mountPath: /mnt/kv-cache }
      volumes:
        - name: kv-cache
          csi:
            driver: kv.k1c.io
            volumeAttributes: { namespaceRef: cache }
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

  it('throws LowerError when ConfigMap reference is unresolved', async () => {
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
    await expect(lowerYaml(yaml)).rejects.toThrow(LowerError);
    await expect(lowerYaml(yaml)).rejects.toThrow(/ConfigMap.*missing/);
  });

  it('throws LowerError when Secret key is missing on a found Secret', async () => {
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
    await expect(lowerYaml(yaml)).rejects.toThrow(/Secret.*creds.*TOKEN/);
  });

  it('throws when volumeMount has no matching volume', async () => {
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
    await expect(lowerYaml(yaml)).rejects.toThrow(/volumeMount.*missing/);
  });

  it('lowers a multi-container Deployment into N Workers wired by service bindings', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: gateway, image: ./gateway.js }
        - { name: sidecar, image: ./sidecar.js }
`);
    expect(result.desired).toHaveLength(2);
    const primary = result.desired.find((d) => d.label === 'default/api')!;
    const sidecar = result.desired.find((d) => d.label === 'default/api--sidecar')!;
    expect(primary).toBeDefined();
    expect(sidecar).toBeDefined();

    const primaryProps = primary.properties as Record<string, unknown>;
    const sidecarProps = sidecar.properties as Record<string, unknown>;
    expect(primaryProps.scriptName).toBe('k1c--default--api');
    expect(sidecarProps.scriptName).toBe('k1c--default--api--sidecar');

    expect(primaryProps.bindings as Array<Record<string, string>>).toContainEqual({
      type: 'service',
      name: 'sidecar',
      service: 'k1c--default--api--sidecar',
    });
    expect(sidecarProps.bindings as Array<Record<string, string>>).toContainEqual({
      type: 'service',
      name: 'gateway',
      service: 'k1c--default--api',
    });
  });

  it('keeps per-container env / volumes isolated in multi-container Deployment', async () => {
    const result = await lowerYaml(`
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg }
data: { LEVEL: info }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: gateway
          image: ./gateway.js
          env: [{ name: ROLE, value: gateway }]
        - name: sidecar
          image: ./sidecar.js
          env:
            - name: LEVEL
              valueFrom: { configMapKeyRef: { name: cfg, key: LEVEL } }
`);
    const primary = result.desired.find((d) => d.label === 'default/api')!;
    const sidecar = result.desired.find((d) => d.label === 'default/api--sidecar')!;
    expect((primary.properties as Record<string, unknown>).vars).toEqual({ ROLE: 'gateway' });
    expect((sidecar.properties as Record<string, unknown>).vars).toEqual({ LEVEL: 'info' });
    expect((sidecar.dependsOn ?? []).some((r) => r.kind === 'ConfigMap')).toBe(true);
    expect((primary.dependsOn ?? []).some((r) => r.kind === 'ConfigMap')).toBe(false);
  });

  it('emits ai / browser / version_metadata bindings from Pod annotations', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/ai: enabled
    cloudflare.com/browser-rendering: HEADLESS
    cloudflare.com/version-metadata: enabled
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    const bindings = props.bindings as Array<Record<string, string>>;
    expect(bindings).toContainEqual({ type: 'ai', name: 'AI' });
    expect(bindings).toContainEqual({ type: 'browser', name: 'HEADLESS' });
    expect(bindings).toContainEqual({ type: 'version_metadata', name: 'CF_VERSION' });
  });

  it('emits images binding from a Pod annotation', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/images: enabled
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    const bindings = props.bindings as ReadonlyArray<Record<string, string>>;
    expect(bindings).toContainEqual({ type: 'images', name: 'IMAGES' });
  });

  it('emits worker_loader binding from a Pod annotation for Dynamic Workers', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/worker-loader: enabled
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    const bindings = props.bindings as ReadonlyArray<Record<string, string>>;
    expect(bindings).toContainEqual({ type: 'worker_loader', name: 'LOADER' });
  });

  it('wires Cloudflare Agents and AI Gateway annotations into a Worker', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AIGateway
metadata: { name: chat }
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: assistant
  annotations:
    cloudflare.com/ai: enabled
    cloudflare.com/ai-gateway-ref: chat
    cloudflare.com/ai-gateway-var: AI_GATEWAY_ID
    cloudflare.com/agent-classes: ChatAgent, ToolAgent
spec:
  selector: { matchLabels: { app: assistant } }
  template:
    spec:
      containers:
        - { name: assistant, image: ./dist/assistant.js }
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    expect(props.bindings).toContainEqual({ type: 'ai', name: 'AI' });
    expect(props.vars).toMatchObject({ AI_GATEWAY_ID: 'k1c-default-chat' });
    expect(props.compatibilityFlags).toEqual(['nodejs_compat']);
    expect(props.durableObjectClasses).toEqual(['ChatAgent', 'ToolAgent']);
    expect(worker.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'AIGateway', name: 'chat' }),
    );
  });

  it('binds a DispatchNamespace to a regular Deployment for Workers for Platforms', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DispatchNamespace
metadata: { name: production }
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: dispatcher }
spec:
  selector: { matchLabels: { app: dispatcher } }
  template:
    spec:
      containers:
        - name: dispatcher
          image: ./dist/dispatcher.js
          volumeMounts:
            - { name: users, mountPath: /mnt/users }
      volumes:
        - name: users
          csi:
            driver: dispatch-namespace.k1c.io
            volumeAttributes:
              ref: production
              binding: DISPATCHER
              remote: "true"
`);
    const worker = result.desired.find((d) => d.resourceType === 'Worker')!;
    const props = worker.properties as Record<string, unknown>;
    const bindings = props.bindings as ReadonlyArray<Record<string, unknown>>;
    expect(bindings).toContainEqual({
      type: 'dispatch_namespace',
      name: 'DISPATCHER',
      dispatchNamespace: 'k1c-default-production',
      remote: true,
    });
    expect(worker.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'DispatchNamespace', name: 'production' }),
    );
  });

  it('emits mtls_certificate binding from volume.mtlsCertificateRef', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./api.js
          volumeMounts:
            - { name: mtls, mountPath: /mnt/mtls }
      volumes:
        - name: mtls
          csi:
            driver: mtls.k1c.io
            volumeAttributes: { certificateId: cert-abc-123 }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    const bindings = props.bindings as ReadonlyArray<Record<string, string>>;
    expect(bindings).toContainEqual({
      type: 'mtls_certificate',
      name: 'MTLS',
      certificateId: 'cert-abc-123',
    });
  });

  it('emits pipelines binding from volume.pipelinesRef', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./api.js
          volumeMounts:
            - { name: events, mountPath: /mnt/events }
      volumes:
        - name: events
          csi:
            driver: pipelines.k1c.io
            volumeAttributes: { pipelineId: pipe-xyz }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    const bindings = props.bindings as ReadonlyArray<Record<string, string>>;
    expect(bindings).toContainEqual({
      type: 'pipelines',
      name: 'EVENTS',
      pipeline: 'pipe-xyz',
    });
  });

  it('emits analytics_engine binding from volume.analyticsEngineRef', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./api.js
          volumeMounts: [{ name: metrics, mountPath: /mnt/metrics }]
      volumes:
        - name: metrics
          csi:
            driver: analytics-engine.k1c.io
            volumeAttributes: { dataset: my_dataset }
`);
    const bindings = (result.desired[0]!.properties as Record<string, unknown>)
      .bindings as Array<Record<string, string>>;
    expect(bindings).toContainEqual({
      type: 'analytics_engine',
      name: 'METRICS',
      dataset: 'my_dataset',
    });
  });

  it('lowers LogpushJob (zone-scoped) to a DesiredResource', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: LogpushJob
metadata: { name: workers-trace }
spec:
  zoneId: zone-abc
  dataset: workers_trace_events
  destinationConf: r2://my-bucket/path
  enabled: true
`);
    const j = result.desired[0]!;
    expect(j.resourceType).toBe('LogpushJob');
    expect(j.label).toBe('default/workers-trace');
    expect(j.properties).toEqual({
      jobName: 'k1c-default-workers-trace',
      scope: { zoneId: 'zone-abc' },
      dataset: 'workers_trace_events',
      destinationConf: 'r2://my-bucket/path',
      enabled: true,
    });
  });

  it('lowers LogpushJob (account-scoped) to a DesiredResource', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: LogpushJob
metadata: { name: audit }
spec:
  accountId: acc-1
  dataset: audit_logs
  destinationConf: r2://audit-bucket
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.scope).toEqual({ accountId: 'acc-1' });
  });

  it('rejects LogpushJob with both zoneId and accountId', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: LogpushJob
metadata: { name: bad }
spec:
  zoneId: z
  accountId: a
  dataset: dns_logs
  destinationConf: r2://x
`),
    ).toThrow(/exactly one of zoneId/);
  });

  it('lowers Vectorize to a DesiredResource with prefixed indexName', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Vectorize
metadata: { name: docs }
spec: { dimensions: 1536, metric: cosine, description: "OpenAI text-embedding-3-small" }
`);
    const v = result.desired[0]!;
    expect(v.resourceType).toBe('Vectorize');
    expect(v.label).toBe('default/docs');
    expect(v.properties).toEqual({
      indexName: 'k1c-default-docs',
      dimensions: 1536,
      metric: 'cosine',
      description: 'OpenAI text-embedding-3-small',
    });
  });

  it('emits vectorize Worker binding from volume.vectorizeRef', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Vectorize
metadata: { name: docs }
spec: { dimensions: 768, metric: cosine }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: rag }
spec:
  selector: { matchLabels: { app: rag } }
  template:
    spec:
      containers:
        - name: rag
          image: ./rag.js
          volumeMounts: [{ name: docs, mountPath: /mnt/docs }]
      volumes:
        - name: docs
          csi:
            driver: vectorize.k1c.io
            volumeAttributes: { ref: docs }
`);
    const rag = result.desired.find((d) => d.label === 'default/rag')!;
    const bindings = (rag.properties as Record<string, unknown>).bindings as Array<
      Record<string, string>
    >;
    expect(bindings).toContainEqual({
      type: 'vectorize',
      name: 'DOCS',
      indexName: 'k1c-default-docs',
    });
  });

  it('lowers DNSRecord to a DesiredResource keyed on hostname', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DNSRecord
metadata: { name: api-cname }
spec:
  zoneId: zone-abc
  type: CNAME
  name: api.example.com
  content: api.workers.dev
  proxied: true
`);
    const r = result.desired[0]!;
    expect(r.resourceType).toBe('DNSRecord');
    expect(r.label).toBe('default/api-cname');
    expect(r.properties).toEqual({
      zoneId: 'zone-abc',
      type: 'CNAME',
      name: 'api.example.com',
      content: 'api.workers.dev',
      proxied: true,
    });
  });

  it('lowers Job into a Worker + Workflow registration pair', async () => {
    const result = await lowerYaml(`
apiVersion: batch/v1
kind: Job
metadata:
  name: import-data
  annotations:
    cloudflare.com/workflow-class: ImportFlow
spec:
  template:
    spec:
      containers:
        - { name: import, image: ./import.js }
`);
    expect(result.desired).toHaveLength(2);
    const worker = result.desired.find((d) => d.resourceType === 'Worker');
    const workflow = result.desired.find((d) => d.resourceType === 'Workflow');
    expect(worker).toBeDefined();
    expect(workflow).toBeDefined();
    expect(workflow!.properties).toEqual({
      workflowName: 'k1c-default-import-data',
      className: 'ImportFlow',
      scriptName: 'k1c--default--import-data',
    });
    expect(workflow!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Job', name: 'import-data' }),
    );
  });

  it('rejects Job whose derived workflow class name is invalid', async () => {
    await expect(
      lowerYaml(`
apiVersion: batch/v1
kind: Job
metadata: { name: 1import }
spec:
  template:
    spec:
      containers: [{ name: c, image: ./c.js }]
`),
    ).rejects.toThrow(/not a valid JS identifier/);
  });

  it('lowers StatefulSet to a Worker with durableObjectClasses derived from name', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: chatroom }
spec:
  serviceName: chatroom-svc
  selector: { matchLabels: { app: chatroom } }
  template:
    spec:
      containers: [{ name: chat, image: ./chat.js }]
`);
    const w = result.desired[0]!;
    expect(w.resourceType).toBe('Worker');
    expect(w.label).toBe('default/chatroom');
    const props = w.properties as Record<string, unknown>;
    // Default class name = PascalCase(metadata.name)
    expect(props.durableObjectClasses).toEqual(['Chatroom']);
  });

  it('honours cloudflare.com/durable-object-class annotation', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: chatroom
  annotations:
    cloudflare.com/durable-object-class: ChatRoomDO
spec:
  selector: { matchLabels: { app: chatroom } }
  template:
    spec:
      containers: [{ name: chat, image: ./chat.js }]
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.durableObjectClasses).toEqual(['ChatRoomDO']);
  });

  it('rejects StatefulSet whose derived class name is not a valid JS identifier', async () => {
    await expect(
      lowerYaml(`
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: chat-room }
spec:
  selector: { matchLabels: { app: x } }
  template:
    spec:
      containers: [{ name: c, image: ./c.js }]
`),
    ).rejects.toThrow(/not a valid JS identifier/);
  });

  it('lowers D1Database to a DesiredResource with prefixed databaseName', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: D1Database
metadata: { name: app-db, namespace: prod }
spec: { primaryLocationHint: weur }
`);
    const d1 = result.desired[0]!;
    expect(d1.resourceType).toBe('D1Database');
    expect(d1.label).toBe('prod/app-db');
    expect(d1.properties).toEqual({
      databaseName: 'k1c-prod-app-db',
      primaryLocationHint: 'weur',
    });
  });

  it('emits d1 Worker binding from volume.d1DatabaseRef', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: D1Database
metadata: { name: app-db }
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
          image: ./api.js
          volumeMounts:
            - { name: db, mountPath: /mnt/db }
      volumes:
        - name: db
          csi:
            driver: d1.k1c.io
            volumeAttributes: { ref: app-db }
`);
    const api = result.desired.find((d) => d.label === 'default/api')!;
    const bindings = (api.properties as Record<string, unknown>).bindings as Array<
      Record<string, string>
    >;
    expect(bindings).toContainEqual(expect.objectContaining({ type: 'd1', name: 'DB' }));
    expect(api.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'D1Database', name: 'app-db' }),
    );
  });

  it('lowers Queue to a DesiredResource and produces queue Worker binding', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Queue
metadata: { name: jobs }
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: producer }
spec:
  selector: { matchLabels: { app: producer } }
  template:
    spec:
      containers:
        - name: producer
          image: ./producer.js
          volumeMounts: [{ name: jobs, mountPath: /mnt/jobs }]
      volumes:
        - name: jobs
          csi:
            driver: queue.k1c.io
            volumeAttributes: { ref: jobs }
`);
    const queue = result.desired.find((d) => d.resourceType === 'Queue')!;
    expect(queue.label).toBe('default/jobs');
    expect((queue.properties as Record<string, unknown>).queueName).toBe('k1c-default-jobs');

    const producer = result.desired.find((d) => d.label === 'default/producer')!;
    const bindings = (producer.properties as Record<string, unknown>).bindings as Array<
      Record<string, string>
    >;
    expect(bindings).toContainEqual({
      type: 'queue',
      name: 'JOBS',
      queueName: 'k1c-default-jobs',
    });
  });

  it('wires Queue.spec.consumer to a Worker via consumerWorkerName', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Queue
metadata: { name: jobs }
spec:
  consumer: { workerName: worker }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker }
spec:
  selector: { matchLabels: { app: worker } }
  template:
    spec:
      containers: [{ name: worker, image: ./worker.js }]
`);
    const queue = result.desired.find((d) => d.resourceType === 'Queue')!;
    const props = queue.properties as Record<string, unknown>;
    expect(props.consumerWorkerName).toBe('k1c--default--worker');
    expect(queue.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Deployment', name: 'worker' }),
    );
  });

  it('lowers Hyperdrive, resolving password from a referenced Secret', async () => {
    const result = await lowerYaml(`
apiVersion: v1
kind: Secret
metadata: { name: db-creds }
stringData: { PASSWORD: hunter2 }
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Hyperdrive
metadata: { name: app-db }
spec:
  origin:
    scheme: postgres
    host: db.internal
    port: 5432
    database: app
    user: app
    passwordSecretRef: { name: db-creds, key: PASSWORD }
  caching: { disabled: false, maxAge: 60 }
`);
    const hd = result.desired.find((d) => d.resourceType === 'Hyperdrive');
    expect(hd).toBeDefined();
    expect(hd!.label).toBe('default/app-db');
    const props = hd!.properties as Record<string, unknown>;
    expect(props.name).toBe('k1c-default-app-db');
    expect((props.origin as Record<string, unknown>).password).toBe('hunter2');
    expect((props.origin as Record<string, unknown>).host).toBe('db.internal');
    expect(hd!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Secret', name: 'db-creds' }),
    );
  });

  it('throws when Hyperdrive password Secret is missing', async () => {
    await expect(
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Hyperdrive
metadata: { name: app-db }
spec:
  origin:
    scheme: postgres
    host: db.internal
    port: 5432
    database: app
    user: app
    passwordSecretRef: { name: missing, key: PASSWORD }
`),
    ).rejects.toThrow(/Secret "missing"/);
  });

  it('emits hyperdrive Worker binding from volume.hyperdriveRef', async () => {
    const result = await lowerYaml(`
apiVersion: v1
kind: Secret
metadata: { name: db-creds }
stringData: { PASSWORD: x }
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Hyperdrive
metadata: { name: app-db }
spec:
  origin:
    scheme: postgres
    host: db.internal
    port: 5432
    database: app
    user: app
    passwordSecretRef: { name: db-creds, key: PASSWORD }
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
          image: ./api.js
          volumeMounts:
            - { name: db, mountPath: /mnt/db }
      volumes:
        - name: db
          csi:
            driver: hyperdrive.k1c.io
            volumeAttributes: { ref: app-db }
`);
    const api = result.desired.find((d) => d.label === 'default/api')!;
    const bindings = (api.properties as Record<string, unknown>).bindings as Array<
      Record<string, string>
    >;
    expect(bindings).toContainEqual(
      expect.objectContaining({ type: 'hyperdrive', name: 'DB' }),
    );
    expect(api.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Hyperdrive', name: 'app-db' }),
    );
  });

  it('lowers CronJob into a Worker with cronSchedules', async () => {
    const result = await lowerYaml(`
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-cleanup }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - { name: cleanup, image: ./dist/cleanup.js }
`);
    expect(result.desired).toHaveLength(1);
    const w = result.desired[0]!;
    expect(w.resourceType).toBe('Worker');
    expect(w.label).toBe('default/nightly-cleanup');
    const props = w.properties as Record<string, unknown>;
    expect(props.scriptName).toBe('k1c--default--nightly-cleanup');
    expect(props.cronSchedules).toEqual(['0 3 * * *']);
  });

  it('emits empty cronSchedules when CronJob.spec.suspend is true', async () => {
    const result = await lowerYaml(`
apiVersion: batch/v1
kind: CronJob
metadata: { name: paused }
spec:
  schedule: "0 3 * * *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - { name: c, image: ./c.js }
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.cronSchedules).toEqual([]);
  });

  it('rejects multi-container CronJob (v0.2 limitation)', async () => {
    await expect(
      lowerYaml(`
apiVersion: batch/v1
kind: CronJob
metadata: { name: nope }
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - { name: a, image: ./a.js }
            - { name: b, image: ./b.js }
`),
    ).rejects.toThrow(/exactly one container/);
  });

  it('rejects multi-container Rollout in the canary path (v0.1.6 limitation)', async () => {
    await expect(
      lowerYaml(`
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
      containers:
        - { name: a, image: ./a.js }
        - { name: b, image: ./b.js }
  strategy: { blueGreen: { autoPromotionEnabled: true } }
`),
    ).rejects.toThrow(/single container only/);
  });

  it('rejects cross-namespace ConfigMap reference', async () => {
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
    await expect(lowerYaml(yaml)).rejects.toThrow(/ConfigMap.*cfg/);
  });

  it('lowers Rollout (blueGreen) into a Worker with no warnings', async () => {
    const result = await lowerYaml(`
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

  it('lowers Rollout with cloudflare.com/dispatch-namespace into dispatcher + stable + state KV', async () => {
    const result = await lowerYaml(`
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

  it('does not duplicate the rollout-state KV when multiple Rollouts share a dispatch namespace', async () => {
    const result = await lowerYaml(`
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

  it('warns when Rollout uses canary strategy (not yet implemented)', async () => {
    const result = await lowerYaml(`
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

  it('warns when Rollout disables auto-promotion (not yet implemented)', async () => {
    const result = await lowerYaml(`
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

  it('does not duplicate dependsOn entries when one resource is referenced twice', async () => {
    const result = await lowerYaml(`
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

  it('lowers Service type=LoadBalancer to a CustomDomain pointing at the matched Worker', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api, tier: web } }
  template:
    spec:
      containers: [{ name: api, image: ./dist/worker.js }]
---
apiVersion: v1
kind: Service
metadata:
  name: api-domain
  annotations:
    cloudflare.com/zone-id: zone-abc
    cloudflare.com/hostname: api.example.com
spec:
  type: LoadBalancer
  selector: { app: api }
  ports: [{ port: 443 }]
`);
    const domain = result.desired.find((d) => d.resourceType === 'CustomDomain');
    expect(domain).toBeDefined();
    expect(domain!.label).toBe('api.example.com');
    expect(domain!.properties).toEqual({
      hostname: 'api.example.com',
      service: 'k1c--default--api',
      zoneId: 'zone-abc',
      environment: 'production',
    });
    expect(domain!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Deployment', name: 'api' }),
    );
  });

  it('auto-emits a proxied CNAME DNSRecord when Service carries cloudflare.com/manage-dns: true', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata:
  name: api-domain
  annotations:
    cloudflare.com/zone-id: zone-abc
    cloudflare.com/hostname: api.example.com
    cloudflare.com/manage-dns: 'true'
spec:
  type: LoadBalancer
  selector: { app: api }
`);
    const dns = result.desired.find((d) => d.resourceType === 'DNSRecord');
    expect(dns).toBeDefined();
    expect(dns!.label).toBe('default/api-domain--dns');
    expect(dns!.properties).toEqual({
      zoneId: 'zone-abc',
      type: 'CNAME',
      name: 'api.example.com',
      content: 'api.example.com',
      proxied: true,
    });
    expect(dns!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Service', name: 'api-domain' }),
    );
  });

  it('honors cloudflare.com/dns-content override when auto-emitting DNS', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata:
  name: api-domain
  annotations:
    cloudflare.com/zone-id: zone-abc
    cloudflare.com/hostname: api.example.com
    cloudflare.com/manage-dns: 'true'
    cloudflare.com/dns-content: api.workers.dev
spec:
  type: LoadBalancer
  selector: { app: api }
`);
    const dns = result.desired.find((d) => d.resourceType === 'DNSRecord');
    expect((dns!.properties as Record<string, unknown>).content).toBe('api.workers.dev');
  });

  it('does NOT emit a DNSRecord when manage-dns is missing or set to anything other than "true"', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata:
  name: api-domain
  annotations:
    cloudflare.com/zone-id: zone-abc
    cloudflare.com/hostname: api.example.com
spec:
  type: LoadBalancer
  selector: { app: api }
`);
    expect(result.desired.find((d) => d.resourceType === 'DNSRecord')).toBeUndefined();
  });

  it('throws when LoadBalancer Service has no matching Deployment/Rollout', async () => {
    await expect(
      lowerYaml(`
apiVersion: v1
kind: Service
metadata:
  name: api-domain
  annotations:
    cloudflare.com/zone-id: z1
    cloudflare.com/hostname: api.example.com
spec:
  type: LoadBalancer
  selector: { app: ghost }
`),
    ).rejects.toThrow(/no Deployment or Rollout/);
  });

  it('throws when LoadBalancer Service is missing required annotations', async () => {
    await expect(
      lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./dist/worker.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-domain }
spec:
  type: LoadBalancer
  selector: { app: api }
`),
    ).rejects.toThrow(/cloudflare.com\/zone-id.*cloudflare.com\/hostname/);
  });

  it('resolves volumeMount serviceRef against a ClusterIP Service to a service binding', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: auth }
spec:
  selector: { matchLabels: { app: auth } }
  template:
    spec:
      containers: [{ name: auth, image: ./auth.js }]
---
apiVersion: v1
kind: Service
metadata: { name: auth-svc }
spec:
  type: ClusterIP
  selector: { app: auth }
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
          image: ./api.js
          volumeMounts:
            - { name: auth, mountPath: /mnt/auth }
      volumes:
        - name: auth
          csi:
            driver: service.k1c.io
            volumeAttributes: { ref: auth-svc }
`);
    const api = result.desired.find((d) => d.label === 'default/api')!;
    const props = api.properties as Record<string, unknown>;
    const bindings = props.bindings as Array<Record<string, string>>;
    expect(bindings).toContainEqual({
      type: 'service',
      name: 'AUTH',
      service: 'k1c--default--auth',
    });
    expect(api.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Service', name: 'auth-svc' }),
    );
  });

  it('warns when ClusterIP Service has no matching workload', async () => {
    const result = await lowerYaml(`
apiVersion: v1
kind: Service
metadata: { name: ghost-svc }
spec:
  type: ClusterIP
  selector: { app: ghost }
`);
    expect(result.desired).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/no matching Deployment/);
  });

  it('throws when volume serviceRef points at an undeclared Service', async () => {
    await expect(
      lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./api.js
          volumeMounts:
            - { name: x, mountPath: /mnt/x }
      volumes:
        - name: x
          csi:
            driver: service.k1c.io
            volumeAttributes: { ref: missing-svc }
`),
    ).rejects.toThrow(/Service "missing-svc" not found/);
  });

  it('lowers Ingress to a router Worker + per-host CustomDomain', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  selector: { matchLabels: { app: web } }
  template:
    spec:
      containers: [{ name: web, image: ./web.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: v1
kind: Service
metadata: { name: web-svc }
spec:
  selector: { app: web }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: site
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: api-svc, port: { number: 80 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: web-svc, port: { number: 80 } } }
`);
    const router = result.desired.find(
      (d) => d.resourceType === 'Worker' && d.label === 'default/site--router',
    );
    expect(router).toBeDefined();
    const props = router!.properties as Record<string, unknown>;
    expect(props.scriptName).toBe('k1c--default--site--ingress');
    expect(typeof props.entrypointContent).toBe('string');
    const bindings = props.bindings as ReadonlyArray<Record<string, string>>;
    // Two service bindings, one per backend Service.
    expect(bindings.filter((b) => b.type === 'service')).toHaveLength(2);
    const services = new Set(bindings.map((b) => b.service));
    expect(services.has('k1c--default--api')).toBe(true);
    expect(services.has('k1c--default--web')).toBe(true);

    const cd = result.desired.find((d) => d.resourceType === 'CustomDomain');
    expect(cd).toBeDefined();
    expect(cd!.label).toBe('example.com');
    expect((cd!.properties as Record<string, string>).service).toBe(
      'k1c--default--site--ingress',
    );
    expect(cd!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Ingress', name: 'site--router' }),
    );
  });

  it('lowers Ingress with multiple hosts into one CustomDomain per host', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - host: a.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: api-svc } }
    - host: b.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: api-svc } }
`);
    const cds = result.desired.filter((d) => d.resourceType === 'CustomDomain');
    expect(cds).toHaveLength(2);
    const hostnames = cds.map((d) => (d.properties as Record<string, string>).hostname).sort();
    expect(hostnames).toEqual(['a.example.com', 'b.example.com']);
  });

  it('emits a WorkerRoute for each wildcard host alongside literal CustomDomains', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wild
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - host: example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: api-svc } } }
    - host: '*.example.com'
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: api-svc } } }
`);
    const cds = result.desired.filter((d) => d.resourceType === 'CustomDomain');
    expect(cds).toHaveLength(1);
    const routes = result.desired.filter((d) => d.resourceType === 'WorkerRoute');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.label).toBe('*.example.com/*');
    expect(routes[0]!.properties).toEqual({
      zoneId: 'zone-abc',
      pattern: '*.example.com/*',
      scriptName: 'k1c--default--wild--ingress',
    });
  });

  it('accepts a wildcard-only Ingress and binds via WorkerRoute', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tenants
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - host: '*.tenants.example.com'
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: api-svc } } }
`);
    expect(result.desired.filter((d) => d.resourceType === 'CustomDomain')).toHaveLength(0);
    expect(result.desired.filter((d) => d.resourceType === 'WorkerRoute')).toHaveLength(1);
  });

  it('rejects Ingress without any host', async () => {
    await expect(
      lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oops
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: api-svc } } }
`),
    ).rejects.toThrow(/at least one rule must specify a host/);
  });

  it('rejects Ingress backend referencing a non-existent Service', async () => {
    await expect(
      lowerYaml(`
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oops
  annotations:
    cloudflare.com/zone-id: zone-abc
spec:
  rules:
    - host: example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: ghost } } }
`),
    ).rejects.toThrow(/backend Service "ghost" .* not found/);
  });

  it('rejects Ingress missing the cloudflare.com/zone-id annotation', async () => {
    await expect(
      lowerYaml(`
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: oops }
spec:
  rules:
    - host: example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: anything } } }
`),
    ).rejects.toThrow(/cloudflare.com\/zone-id/);
  });

  it('lowers AccessApplication translating camelCase rules to snake_case wire shape', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata:
  name: internal
  namespace: prod
spec:
  domain: internal.example.com
  sessionDuration: 24h
  autoRedirectToIdentity: true
  allowedIdps: [idp-a]
  policies:
    - name: dev-allow
      decision: allow
      include:
        - { emailDomain: { domain: anthropic.com } }
        - { email: { email: alice@example.com } }
      exclude:
        - { ip: { ip: 1.2.3.4 } }
      require:
        - { country: { code: US } }
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('AccessApplication');
    expect(d.label).toBe('prod/internal');
    expect(d.properties).toEqual({
      appName: 'k1c-prod-internal',
      domain: 'internal.example.com',
      appType: 'self_hosted',
      sessionDuration: '24h',
      autoRedirectToIdentity: true,
      allowedIdps: ['idp-a'],
      policies: [
        {
          name: 'dev-allow',
          decision: 'allow',
          include: [
            { email_domain: { domain: 'anthropic.com' } },
            { email: { email: 'alice@example.com' } },
          ],
          exclude: [{ ip: { ip: '1.2.3.4' } }],
          require: [{ country: { country_code: 'US' } }],
        },
      ],
    });
  });

  it('lowers AccessApplication with everyone / serviceToken / anyValidServiceToken rules', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: open }
spec:
  domain: open.example.com
  policies:
    - name: open
      decision: allow
      include:
        - { everyone: {} }
        - { serviceToken: { tokenId: tok-123 } }
        - { anyValidServiceToken: {} }
`);
    const policies = (result.desired[0]!.properties as { policies: unknown[] }).policies;
    expect(policies).toEqual([
      {
        name: 'open',
        decision: 'allow',
        include: [
          { everyone: {} },
          { service_token: { token_id: 'tok-123' } },
          { any_valid_service_token: {} },
        ],
      },
    ]);
  });

  it('lowers AccessPolicy to a DesiredResource with prefixed policy name', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessPolicy
metadata: { name: dev-allow, namespace: prod }
spec:
  decision: allow
  include:
    - { emailDomain: { domain: anthropic.com } }
  sessionDuration: 8h
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('AccessPolicy');
    expect(d.label).toBe('prod/dev-allow');
    expect(d.properties).toEqual({
      policyName: 'k1c-prod-dev-allow',
      decision: 'allow',
      include: [{ email_domain: { domain: 'anthropic.com' } }],
      sessionDuration: '8h',
    });
  });

  it('lowers AccessApplication policy ref to a placeholder + dependsOn edge', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessPolicy
metadata: { name: dev-allow }
spec:
  decision: allow
  include:
    - { emailDomain: { domain: anthropic.com } }
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: internal }
spec:
  domain: internal.example.com
  policies:
    - { ref: dev-allow }
    - name: emergency-bypass
      decision: bypass
      include:
        - { everyone: {} }
`);
    const app = result.desired.find((d) => d.resourceType === 'AccessApplication')!;
    const policies = (app.properties as { policies: ReadonlyArray<unknown> }).policies;
    expect(policies[0]).toBe('<resolved-at-apply:AccessPolicy:default/dev-allow>');
    expect(policies[1]).toMatchObject({ name: 'emergency-bypass', decision: 'bypass' });
    expect(app.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'AccessPolicy', name: 'dev-allow' }),
    );
  });

  it('lowers a bookmark AccessApplication without policies and with logoUrl', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: notion }
spec:
  type: bookmark
  domain: https://www.notion.so/anthropic
  logoUrl: https://www.notion.so/favicon.ico
  appLauncherVisible: true
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.appType).toBe('bookmark');
    expect(props.policies).toEqual([]);
    expect(props.logoUrl).toBe('https://www.notion.so/favicon.ico');
    expect(props.appLauncherVisible).toBe(true);
  });

  it('rejects a bookmark AccessApplication that carries policies', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: bad }
spec:
  type: bookmark
  domain: https://example.com
  policies:
    - name: x
      decision: allow
      include: [{ everyone: {} }]
`),
    ).toThrow(/bookmark.*cannot carry policies/);
  });

  it('rejects a self_hosted AccessApplication with no policies', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: bad }
spec:
  domain: internal.example.com
`),
    ).toThrow(/at least one entry in spec.policies/);
  });

  it('forwards spec.type to AccessApplication.appType', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: ssh-jump }
spec:
  domain: ssh.example.com
  type: ssh
  policies:
    - name: allow
      decision: allow
      include:
        - { everyone: {} }
`);
    expect((result.desired[0]!.properties as { appType: string }).appType).toBe('ssh');
  });

  it('rejects AccessApplication policy ref pointing at no AccessPolicy', async () => {
    await expect(
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: internal }
spec:
  domain: internal.example.com
  policies:
    - { ref: ghost }
`),
    ).rejects.toThrow(/policy ref "ghost"/);
  });

  it('lowers CacheRule to a DesiredResource with default enabled=true', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: CacheRule
metadata: { name: static-assets, namespace: prod }
spec:
  zoneId: zone-abc
  expression: '(http.request.uri.path matches "^/static/.*$")'
  cache: true
  edgeTtl: { mode: override_origin, default: 86400 }
  browserTtl: { mode: respect_origin }
  description: 'cache /static for a day'
`);
    expect(result.desired).toHaveLength(1);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('CacheRule');
    expect(d.label).toBe('prod/static-assets');
    expect(d.properties).toEqual({
      zoneId: 'zone-abc',
      expression: '(http.request.uri.path matches "^/static/.*$")',
      cache: true,
      enabled: true,
      edgeTtl: { mode: 'override_origin', default: 86400 },
      browserTtl: { mode: 'respect_origin' },
      description: 'cache /static for a day',
    });
  });

  it('lowers CacheRule with enabled=false', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: CacheRule
metadata: { name: paused }
spec:
  zoneId: zone-abc
  expression: 'true'
  cache: false
  enabled: false
`);
    expect((result.desired[0]!.properties as { enabled: boolean }).enabled).toBe(false);
  });

  it('lowers TransformRule with header set + remove operations', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TransformRule
metadata: { name: api-headers }
spec:
  zoneId: zone-abc
  expression: '(http.request.uri.path matches "^/api/.*$")'
  headers:
    X-Internal-Auth: { operation: set, value: 'shhh' }
    X-Forwarded-For: { operation: remove }
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('TransformRule');
    expect((d.properties as { enabled: boolean }).enabled).toBe(true);
    expect((d.properties as { headers: Record<string, unknown> }).headers).toEqual({
      'X-Internal-Auth': { operation: 'set', value: 'shhh' },
      'X-Forwarded-For': { operation: 'remove' },
    });
  });

  it('lowers WAFCustomRule with action=block', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: WAFCustomRule
metadata: { name: block-bots }
spec:
  zoneId: zone-abc
  expression: '(cf.client.bot)'
  action: block
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('WAFCustomRule');
    expect(d.properties).toMatchObject({ action: 'block', enabled: true });
  });

  it('lowers RateLimitRule preserving ratelimit characteristics + threshold', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: RateLimitRule
metadata: { name: api-throttle }
spec:
  zoneId: zone-abc
  expression: '(http.request.uri.path matches "^/api/.*$")'
  action: block
  ratelimit:
    characteristics: [ip.src, cf.colo.id]
    period: 60
    requestsPerPeriod: 100
    mitigationTimeout: 600
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('RateLimitRule');
    expect((d.properties as { ratelimit: unknown }).ratelimit).toEqual({
      characteristics: ['ip.src', 'cf.colo.id'],
      period: 60,
      requestsPerPeriod: 100,
      mitigationTimeout: 600,
    });
  });

  it('lowers TelemetryStack into one LogpushJob per enabled stream', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TelemetryStack
metadata: { name: prod-obs }
spec:
  zoneId: zone-abc
  workersTrace:
    destination: 'r2://logs/workers/{DATE}.json'
  httpRequests:
    destination: 'r2://logs/http/{DATE}.json'
    filter: '{"where":{"key":"ClientRequestPath","operator":"startsWith","value":"/api/"}}'
  firewallEvents:
    destination: 'r2://logs/waf/{DATE}.json'
    enabled: false
`);
    const jobs = result.desired.filter((d) => d.resourceType === 'LogpushJob');
    expect(jobs.map((j) => j.label).sort()).toEqual([
      'default/prod-obs--firewall',
      'default/prod-obs--http',
      'default/prod-obs--workers',
    ]);
    const workers = jobs.find((j) => j.label === 'default/prod-obs--workers')!.properties as
      Record<string, unknown>;
    expect(workers.dataset).toBe('workers_trace_events');
    expect(workers.scope).toEqual({ accountId: '<resolved-at-apply:Context:accountId>' });
    const http = jobs.find((j) => j.label === 'default/prod-obs--http')!.properties as
      Record<string, unknown>;
    expect(http.scope).toEqual({ zoneId: 'zone-abc' });
    expect(http.filter as string).toContain('ClientRequestPath');
    expect(
      (jobs.find((j) => j.label === 'default/prod-obs--firewall')!.properties as Record<string, unknown>).enabled,
    ).toBe(false);
  });

  it('TelemetryStack with viaAggregator emits a generated aggregator Worker + LogpushJobs pointing at it', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: Queue
metadata: { name: telemetry-events }
spec: {}
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: cold-logs }
spec: {}
---
apiVersion: v1
kind: Secret
metadata: { name: logpush-creds }
stringData:
  hmac: 's3cret'
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TelemetryStack
metadata: { name: agg-stack }
spec:
  zoneId: zone-abc
  workersTrace:
    viaAggregator: true
  httpRequests:
    viaAggregator: true
  aggregator:
    hostname: telemetry.example.com
    queueRef: telemetry-events
    r2Ref: cold-logs
    otlpUrl: 'https://otlp.example/api/traces'
    hmacSecretRef: { name: logpush-creds, key: hmac }
`);
    const aggregator = result.desired.find(
      (d) => d.resourceType === 'Worker' && d.label === 'default/agg-stack--aggregator',
    );
    expect(aggregator).toBeDefined();
    const aggProps = aggregator!.properties as Record<string, unknown>;
    const bindings = aggProps.bindings as Array<Record<string, string>>;
    expect(bindings.find((b) => b.type === 'queue')).toMatchObject({ name: 'QUEUE' });
    expect(bindings.find((b) => b.type === 'r2_bucket')).toMatchObject({ name: 'SINK_R2' });
    expect((aggProps.vars as Record<string, string>).OTLP_URL).toBe(
      'https://otlp.example/api/traces',
    );
    expect((aggProps.secrets as Record<string, string>).LOGPUSH_HMAC).toBe('s3cret');

    const lp = result.desired.filter((d) => d.resourceType === 'LogpushJob');
    expect(lp).toHaveLength(2);
    for (const job of lp) {
      expect((job.properties as Record<string, unknown>).destinationConf).toBe(
        'https://telemetry.example.com/',
      );
    }
  });

  it('rejects TelemetryStack stream with both destination and viaAggregator', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TelemetryStack
metadata: { name: bad }
spec:
  workersTrace:
    destination: 'r2://logs'
    viaAggregator: true
`),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects TelemetryStack stream with neither destination nor viaAggregator', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TelemetryStack
metadata: { name: bad }
spec:
  workersTrace: {}
`),
    ).toThrow(/destination or viaAggregator/);
  });

  it('rejects TelemetryStack with viaAggregator but no aggregator declared', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: TelemetryStack
metadata: { name: bad }
spec:
  workersTrace:
    viaAggregator: true
`),
    ).toThrow(/spec.aggregator is not declared/);
  });

  it('auto-emits a per-Worker LogpushJob from cloudflare.com/logpush annotation', async () => {
    const result = await lowerYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/logpush: 'r2://logs/api/{DATE}.json'
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./api.js }]
`);
    const lp = result.desired.find((d) => d.resourceType === 'LogpushJob');
    expect(lp).toBeDefined();
    expect(lp!.label).toBe('default/api--logpush');
    const props = lp!.properties as Record<string, unknown>;
    expect(props.dataset).toBe('workers_trace_events');
    expect(props.destinationConf).toBe('r2://logs/api/{DATE}.json');
    expect(props.scope).toEqual({ accountId: '<resolved-at-apply:Context:accountId>' });
    expect(props.filter as string).toContain('"ScriptName"');
    expect(props.filter as string).toContain('"k1c--default--api"');
    expect(lp!.dependsOn).toContainEqual(
      expect.objectContaining({ kind: 'Deployment', name: 'api' }),
    );
  });

  it('lowers URIRewriteRule with a static path replacement', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: URIRewriteRule
metadata: { name: api-prefix }
spec:
  zoneId: zone-abc
  expression: '(http.request.uri.path matches "^/v1/.*$")'
  path:
    expression: 'concat("/api", http.request.uri.path)'
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('URIRewriteRule');
    expect(d.properties).toMatchObject({
      enabled: true,
      path: { expression: 'concat("/api", http.request.uri.path)' },
    });
  });

  it('rejects URIRewriteRule with neither path nor query set', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: URIRewriteRule
metadata: { name: bad }
spec:
  zoneId: zone-abc
  expression: 'true'
`),
    ).toThrow(/at least one of spec.path or spec.query/);
  });

  it('lowers ResponseHeaderRule with set + remove operations', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: ResponseHeaderRule
metadata: { name: csp }
spec:
  zoneId: zone-abc
  expression: 'true'
  headers:
    Content-Security-Policy: { operation: set, value: "default-src 'self'" }
    Server: { operation: remove }
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('ResponseHeaderRule');
    expect((d.properties as { headers: Record<string, unknown> }).headers).toEqual({
      'Content-Security-Policy': { operation: 'set', value: "default-src 'self'" },
      Server: { operation: 'remove' },
    });
  });

  it('lowers EmailRoutingRule to a DesiredResource with literal matcher + forward action', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: EmailRoutingRule
metadata: { name: forward-me }
spec:
  zoneId: zone-abc
  ruleName: 'me-to-gmail'
  matchers:
    - { type: literal, field: to, value: me@example.com }
  actions:
    - { type: forward, to: [me@gmail.com] }
`);
    const d = result.desired[0]!;
    expect(d.resourceType).toBe('EmailRoutingRule');
    expect(d.label).toBe('default/forward-me');
    expect(d.properties).toEqual({
      zoneId: 'zone-abc',
      ruleName: 'me-to-gmail',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'me@example.com' }],
      actions: [{ type: 'forward', to: ['me@gmail.com'] }],
    });
  });

  it('lowers EmailRoutingRule with type=all matcher and worker action', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: EmailRoutingRule
metadata: { name: catchall }
spec:
  zoneId: zone-abc
  ruleName: 'catchall'
  matchers:
    - { type: all }
  actions:
    - { type: worker, worker: 'k1c--default--inbox' }
`);
    expect((result.desired[0]!.properties as { matchers: unknown }).matchers).toEqual([
      { type: 'all' },
    ]);
    expect((result.desired[0]!.properties as { actions: unknown }).actions).toEqual([
      { type: 'worker', worker: 'k1c--default--inbox' },
    ]);
  });

  it('lowers WAFManagedRuleset to a DesiredResource with prefixed ruleset id + override action', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: WAFManagedRuleset
metadata: { name: owasp }
spec:
  zoneId: zone-abc
  rulesetId: efb7b8c949ac4650a09736fc376e9aee
  overrideAction: log
`);
    expect(result.desired[0]!.resourceType).toBe('WAFManagedRuleset');
    expect(result.desired[0]!.properties).toMatchObject({
      zoneId: 'zone-abc',
      rulesetId: 'efb7b8c949ac4650a09736fc376e9aee',
      overrideAction: 'log',
      enabled: true,
    });
  });

  it('lowers a saas AccessApplication passing saasApp through verbatim', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: salesforce }
spec:
  type: saas
  domain: anthropic.my.salesforce.com
  saasApp:
    auth_type: saml
    sp_entity_id: salesforce-id
  policies:
    - name: allow
      decision: allow
      include: [{ everyone: {} }]
`);
    const props = result.desired[0]!.properties as Record<string, unknown>;
    expect(props.appType).toBe('saas');
    expect(props.saasApp).toEqual({ auth_type: 'saml', sp_entity_id: 'salesforce-id' });
  });

  it('rejects a saas AccessApplication missing saasApp', () => {
    expect(() =>
      lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: bad }
spec:
  type: saas
  domain: example.com
  policies:
    - name: x
      decision: allow
      include: [{ everyone: {} }]
`),
    ).toThrow(/type=saas AccessApplications require spec.saasApp/);
  });

  it('lowers a biso AccessApplication (Browser Isolation) using the self_hosted shape', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AccessApplication
metadata: { name: untrusted }
spec:
  type: biso
  domain: untrusted.example.com
  policies:
    - name: contractors
      decision: allow
      include: [{ emailDomain: { domain: external.example.com } }]
`);
    const props = result.desired[0]!.properties as { appType: string };
    expect(props.appType).toBe('biso');
  });

  it('lowers CustomHostname to a DesiredResource passing ssl options through', async () => {
    const result = await lowerYaml(`
apiVersion: cloudflare.k1c.io/v1alpha1
kind: CustomHostname
metadata: { name: app, namespace: prod }
spec:
  zoneId: zone-abc
  hostname: app.example.com
  ssl:
    method: http
    type: dv
`);
    expect(result.desired[0]!.resourceType).toBe('CustomHostname');
    expect(result.desired[0]!.label).toBe('prod/app');
    expect(result.desired[0]!.properties).toEqual({
      zoneId: 'zone-abc',
      hostname: 'app.example.com',
      ssl: { method: 'http', type: 'dv' },
    });
  });

  it('hashes the entrypoint content into Worker.entrypointHash', async () => {
    const { resources } = parseManifest(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: [{ name: api, image: ./worker-a.js }]
`);
    const a = await lower(resources, {
      readFile: async () => new TextEncoder().encode('// content v1'),
    });
    const b = await lower(resources, {
      readFile: async () => new TextEncoder().encode('// content v2'),
    });
    const propsA = a.desired[0]!.properties as Record<string, unknown>;
    const propsB = b.desired[0]!.properties as Record<string, unknown>;
    expect(propsA.entrypointHash).toBeTruthy();
    expect(propsB.entrypointHash).toBeTruthy();
    expect(propsA.entrypointHash).not.toBe(propsB.entrypointHash);
  });
});
