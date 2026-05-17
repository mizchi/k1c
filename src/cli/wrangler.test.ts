import { describe, it, expect } from 'vitest';
import { runLogs, runPortForward, runWranglerConfig } from './wrangler.ts';

interface Captured {
  cmd?: string;
  args?: ReadonlyArray<string>;
  stdout: string[];
  stderr: string[];
  exit: number;
}

function buildDeps(exit = 0) {
  const captured: Captured = { stdout: [], stderr: [], exit };
  return {
    captured,
    deps: {
      run: async (cmd: string, args: ReadonlyArray<string>) => {
        captured.cmd = cmd;
        captured.args = args;
        return exit;
      },
      out: (m: string) => captured.stdout.push(m),
      err: (m: string) => captured.stderr.push(m),
    },
  };
}

describe('runLogs', () => {
  it('translates a Deployment into the underlying k1c-- script name and forwards format/status', async () => {
    const { captured, deps } = buildDeps();
    const code = await runLogs(
      {
        kind: 'logs',
        resourceKind: 'Deployment',
        name: 'api',
        namespace: 'prod',
        format: 'json',
        status: 'error',
        limit: 10,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(captured.cmd).toBe('wrangler');
    expect(captured.args).toEqual([
      'tail',
      'k1c--prod--api',
      '--format',
      'json',
      '--status',
      'error',
      '--limit',
      '10',
    ]);
  });

  it('defaults namespace to "default" and format to "pretty" when unspecified', async () => {
    const { captured, deps } = buildDeps();
    await runLogs(
      { kind: 'logs', resourceKind: 'Worker', name: 'hello', format: 'pretty', limit: 0 },
      deps,
    );
    expect(captured.args).toEqual(['tail', 'k1c--default--hello', '--format', 'pretty']);
  });

  it('rejects kinds that do not lower to a Worker', async () => {
    const { captured, deps } = buildDeps();
    const code = await runLogs(
      { kind: 'logs', resourceKind: 'Service', name: 'lb', format: 'pretty', limit: 0 },
      deps,
    );
    expect(code).toBe(2);
    expect(captured.cmd).toBeUndefined();
    expect(captured.stderr.join('\n')).toMatch(/cannot tail kind "Service"/);
  });
});

describe('runPortForward', () => {
  it('invokes wrangler dev --remote on the resolved script name and chosen port', async () => {
    const { captured, deps } = buildDeps();
    await runPortForward(
      { kind: 'port-forward', resourceKind: 'Deployment', name: 'api', localPort: 9000 },
      deps,
    );
    expect(captured.cmd).toBe('wrangler');
    expect(captured.args).toEqual([
      'dev',
      '--remote',
      '--name',
      'k1c--default--api',
      '--port',
      '9000',
    ]);
  });
});

const CONFIG_MANIFEST = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: DispatchNamespace
metadata: { name: production }
spec: {}
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: {}
---
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    cloudflare.com/images: enabled
    cloudflare.com/worker-loader: enabled
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          volumeMounts:
            - { name: r2-media, mountPath: /mnt/r2-media }
            - { name: image-cache, mountPath: /mnt/image-cache }
            - { name: users, mountPath: /mnt/users }
      volumes:
        - name: r2-media
          csi:
            driver: r2.k1c.io
            volumeAttributes:
              bucketRef: media
              binding: R2_MEDIA
        - name: image-cache
          csi:
            driver: kv.k1c.io
            volumeAttributes: { namespaceRef: cache }
        - name: users
          csi:
            driver: dispatch-namespace.k1c.io
            volumeAttributes:
              ref: production
              binding: DISPATCHER
              remote: "true"
`;

function buildConfigDeps(manifest: string = CONFIG_MANIFEST) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    captured: { stdout, stderr },
    deps: {
      readManifest: async () => manifest,
      readFile: async (path: string) => new TextEncoder().encode(`// stub for ${path}`),
      out: (m: string) => stdout.push(m),
      err: (m: string) => stderr.push(m),
    },
  };
}

describe('runWranglerConfig', () => {
  it('prints a wrangler.jsonc-compatible config for the single lowered Worker', async () => {
    const { captured, deps } = buildConfigDeps();
    const code = await runWranglerConfig(
      { kind: 'wrangler-config', file: 'manifest.yaml' },
      deps,
    );
    expect(code).toBe(0);
    const config = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: 'k1c--default--api',
      main: './dist/worker.js',
      no_bundle: true,
      compatibility_date: '2025-01-01',
      images: { binding: 'IMAGES' },
    });
    expect(config.worker_loaders).toEqual([{ binding: 'LOADER' }]);
    expect(config.dispatch_namespaces).toEqual([
      { binding: 'DISPATCHER', namespace: 'k1c-default-production', remote: true },
    ]);
    expect(config.r2_buckets).toEqual([
      { binding: 'R2_MEDIA', bucket_name: 'k1c-default-media' },
    ]);
    expect(config.kv_namespaces).toEqual([{ binding: 'IMAGE_CACHE' }]);
  });

  it('prints Agents Durable Object bindings, migrations, Workers AI, and AI Gateway vars', async () => {
    const { captured, deps } = buildConfigDeps(`
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
    cloudflare.com/agent-classes: ChatAgent
spec:
  selector: { matchLabels: { app: assistant } }
  template:
    spec:
      containers:
        - { name: assistant, image: ./dist/assistant.js }
`);
    const code = await runWranglerConfig(
      { kind: 'wrangler-config', file: 'manifest.yaml' },
      deps,
    );
    expect(code).toBe(0);
    const config = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(config.ai).toEqual({ binding: 'AI' });
    expect(config.vars).toEqual({ AI_GATEWAY_ID: 'k1c-default-chat' });
    expect(config.compatibility_flags).toEqual(['nodejs_compat']);
    expect(config.durable_objects).toEqual({
      bindings: [{ name: 'ChatAgent', class_name: 'ChatAgent' }],
    });
    expect(config.migrations).toEqual([
      { tag: 'k1c-initial', new_sqlite_classes: ['ChatAgent'] },
    ]);
  });

  it('requires --worker when a manifest lowers to multiple Workers', async () => {
    const { captured, deps } = buildConfigDeps(`${CONFIG_MANIFEST}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: admin }
spec:
  selector: { matchLabels: { app: admin } }
  template:
    spec:
      containers:
        - { name: admin, image: ./dist/admin.js }
`);
    const code = await runWranglerConfig(
      { kind: 'wrangler-config', file: 'manifest.yaml' },
      deps,
    );
    expect(code).toBe(2);
    expect(captured.stderr.join('\n')).toMatch(/--worker/);
    expect(captured.stderr.join('\n')).toMatch(/default\/api/);
    expect(captured.stderr.join('\n')).toMatch(/default\/admin/);
  });

  it('selects a Worker by namespace/name', async () => {
    const { captured, deps } = buildConfigDeps(`${CONFIG_MANIFEST}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: admin, namespace: prod }
spec:
  selector: { matchLabels: { app: admin } }
  template:
    spec:
      containers:
        - { name: admin, image: ./dist/admin.js }
`);
    const code = await runWranglerConfig(
      { kind: 'wrangler-config', file: 'manifest.yaml', worker: 'prod/admin' },
      deps,
    );
    expect(code).toBe(0);
    const config = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(config.name).toBe('k1c--prod--admin');
    expect(config.main).toBe('./dist/admin.js');
  });
});
