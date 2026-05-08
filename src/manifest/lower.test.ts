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
          volumeMounts: [{ name: ae, mountPath: METRICS }]
      volumes:
        - { name: ae, analyticsEngineRef: { dataset: my_dataset } }
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
          volumeMounts: [{ name: docs, mountPath: DOCS }]
      volumes:
        - { name: docs, vectorizeRef: { name: docs } }
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
            - { name: db, mountPath: DB }
      volumes:
        - { name: db, d1DatabaseRef: { name: app-db } }
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
          volumeMounts: [{ name: q, mountPath: JOBS }]
      volumes:
        - { name: q, queueRef: { name: jobs } }
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
            - { name: db, mountPath: DB }
      volumes:
        - { name: db, hyperdriveRef: { name: app-db } }
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
            - { name: auth, mountPath: AUTH }
      volumes:
        - { name: auth, serviceRef: { name: auth-svc } }
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
            - { name: x, mountPath: X }
      volumes:
        - { name: x, serviceRef: { name: missing-svc } }
`),
    ).rejects.toThrow(/Service "missing-svc" not found/);
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
