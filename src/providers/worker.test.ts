import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workerProvider } from './worker.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface ScriptsMock {
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
  readonly settings: { readonly get: ReturnType<typeof vi.fn> };
  readonly scriptAndVersionSettings: { readonly get: ReturnType<typeof vi.fn> };
  readonly versions: { readonly create: ReturnType<typeof vi.fn> };
  readonly deployments: { readonly create: ReturnType<typeof vi.fn> };
}

interface DispatchScriptsMock {
  readonly update: ReturnType<typeof vi.fn>;
}

function buildScriptsMock(): ScriptsMock {
  return {
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    settings: { get: vi.fn() },
    scriptAndVersionSettings: { get: vi.fn() },
    versions: { create: vi.fn() },
    deployments: { create: vi.fn() },
  };
}

function buildDispatchMock(): DispatchScriptsMock {
  return { update: vi.fn() };
}

function buildCtx(
  scripts: ScriptsMock,
  options?: { content?: Uint8Array; dispatch?: DispatchScriptsMock },
): ProviderContext {
  const cf = {
    workers: { scripts },
    workersForPlatforms: {
      dispatch: { namespaces: { scripts: options?.dispatch ?? buildDispatchMock() } },
    },
  } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
    readFile: async () =>
      options?.content ?? new TextEncoder().encode('export default { fetch() {} }'),
  };
}

function pageOf<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          i < items.length
            ? Promise.resolve({ value: items[i++]!, done: false as const })
            : Promise.resolve({ value: undefined as unknown as T, done: true as const }),
      };
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const baseProps = {
  scriptName: 'k1c--default--api',
  entrypoint: './dist/worker.js',
  compatibilityDate: '2025-06-01',
};

describe('workerProvider', () => {
  describe('list', () => {
    it('yields scripts with k1c-- prefix and parses double-dash separator', async () => {
      const scripts = buildScriptsMock();
      scripts.list.mockReturnValueOnce(
        pageOf([
          { id: 'k1c--default--api' },
          { id: 'k1c--prod--gateway' },
          { id: 'unmanaged-script' },
        ]),
      );
      const result = await collect(workerProvider.list(buildCtx(scripts)));
      expect(result.map((r) => r.label)).toEqual(['default/api', 'prod/gateway']);
      expect(result.map((r) => r.nativeId)).toEqual([
        'k1c--default--api',
        'k1c--prod--gateway',
      ]);
    });

    it('skips scripts without parsable labels', async () => {
      const scripts = buildScriptsMock();
      scripts.list.mockReturnValueOnce(
        pageOf([{ id: 'k1c--no-second-dash' }, { id: 'k1c--' }, { id: 'k1c--ns--' }]),
      );
      const result = await collect(workerProvider.list(buildCtx(scripts)));
      expect(result).toHaveLength(0);
    });
  });

  describe('create', () => {
    function setup() {
      const scripts = buildScriptsMock();
      scripts.versions.create.mockResolvedValue({ id: 'ver-1', number: 1 });
      scripts.deployments.create.mockResolvedValue({ id: 'dep-1' });
      return scripts;
    }

    it('uploads a new version with main_module + compatibility_date', async () => {
      const scripts = setup();
      const ctx = buildCtx(scripts);
      await workerProvider.create(ctx, 'default/api', baseProps);
      expect(scripts.versions.create).toHaveBeenCalledWith(
        'k1c--default--api',
        expect.objectContaining({
          account_id: 'acc-123',
          metadata: expect.objectContaining({
            main_module: 'worker.mjs',
            compatibility_date: '2025-06-01',
          }),
        }),
      );
    });

    it('routes 100% traffic to the new version via deployments.create', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      expect(scripts.deployments.create).toHaveBeenCalledWith('k1c--default--api', {
        account_id: 'acc-123',
        strategy: 'percentage',
        versions: [{ version_id: 'ver-1', percentage: 100 }],
      });
    });

    it('passes the entrypoint file as a multipart part keyed by main_module name', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      const params = scripts.versions.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(params['worker.mjs']).toBeDefined();
    });

    it('translates vars to plain_text bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        vars: { LOG_LEVEL: 'info', REGION: 'weur' },
      });
      const bindings = scripts.versions.create.mock.calls[0]![1].metadata.bindings as Array<
        Record<string, string>
      >;
      expect(bindings).toContainEqual({ type: 'plain_text', name: 'LOG_LEVEL', text: 'info' });
      expect(bindings).toContainEqual({ type: 'plain_text', name: 'REGION', text: 'weur' });
    });

    it('translates secrets to secret_text bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        secrets: { TOKEN: 'shh' },
      });
      const bindings = scripts.versions.create.mock.calls[0]![1].metadata.bindings as Array<
        Record<string, string>
      >;
      expect(bindings).toContainEqual({ type: 'secret_text', name: 'TOKEN', text: 'shh' });
    });

    it('translates r2_bucket / kv_namespace / service bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        bindings: [
          { type: 'r2_bucket', name: 'R2_MEDIA', bucketName: 'k1c-default-media' },
          { type: 'kv_namespace', name: 'KV_CACHE', namespaceId: 'id-1' },
          { type: 'service', name: 'API', service: 'k1c--default--auth' },
        ],
      });
      const bindings = scripts.versions.create.mock.calls[0]![1].metadata.bindings as Array<
        Record<string, string>
      >;
      expect(bindings).toContainEqual({
        type: 'r2_bucket',
        name: 'R2_MEDIA',
        bucket_name: 'k1c-default-media',
      });
      expect(bindings).toContainEqual({
        type: 'kv_namespace',
        name: 'KV_CACHE',
        namespace_id: 'id-1',
      });
      expect(bindings).toContainEqual({
        type: 'service',
        name: 'API',
        service: 'k1c--default--auth',
      });
    });

    it('attaches managed-by tag', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      const tags = scripts.versions.create.mock.calls[0]![1].metadata.tags as string[];
      expect(tags).toContain('k1c.io/managed-by=k1c');
    });

    it('embeds the entrypointHash into metadata.tags as k1c.io/content-hash=...', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        entrypointHash: 'abcdef0123',
      });
      const tags = scripts.versions.create.mock.calls[0]![1].metadata.tags as string[];
      expect(tags).toContain('k1c.io/content-hash=abcdef0123');
    });

    it('passes observability and placement when set', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        observability: { enabled: true },
        placement: { mode: 'smart' },
      });
      const meta = scripts.versions.create.mock.calls[0]![1].metadata;
      expect(meta.observability).toEqual({ enabled: true });
      expect(meta.placement).toEqual({ mode: 'smart' });
    });

    it('uploads compatibility_flags when provided', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
      });
      const meta = scripts.versions.create.mock.calls[0]![1].metadata;
      expect(meta.compatibility_flags).toEqual([
        'nodejs_compat',
        'streams_enable_constructors',
      ]);
    });

    it('uses ctx.readFile to load the entrypoint', async () => {
      const scripts = setup();
      const readFile = vi.fn().mockResolvedValue(new TextEncoder().encode('// custom'));
      const ctx = { ...buildCtx(scripts), readFile };
      await workerProvider.create(ctx, 'default/api', baseProps);
      expect(readFile).toHaveBeenCalledWith('./dist/worker.js');
    });

    it('uses entrypointContent verbatim when set, bypassing ctx.readFile', async () => {
      const scripts = setup();
      const readFile = vi.fn();
      const ctx = { ...buildCtx(scripts), readFile };
      await workerProvider.create(ctx, 'default/api', {
        ...baseProps,
        entrypointContent: '// inline source',
      });
      expect(readFile).not.toHaveBeenCalled();
      expect(scripts.versions.create).toHaveBeenCalled();
    });

    it('translates dispatch_namespace bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/dispatcher', {
        ...baseProps,
        bindings: [
          { type: 'dispatch_namespace', name: 'NAMESPACE', dispatchNamespace: 'k1c-default-prod' },
        ],
      });
      const bindings = scripts.versions.create.mock.calls[0]![1].metadata.bindings as Array<
        Record<string, string>
      >;
      expect(bindings).toContainEqual({
        type: 'dispatch_namespace',
        name: 'NAMESPACE',
        namespace: 'k1c-default-prod',
      });
    });

    it('uploads to dispatch namespace when dispatchNamespace property is set', async () => {
      const scripts = buildScriptsMock();
      const dispatch = buildDispatchMock();
      dispatch.update.mockResolvedValueOnce({});
      const ctx = buildCtx(scripts, { dispatch });
      await workerProvider.create(ctx, 'default/api', {
        ...baseProps,
        scriptName: 'k1c--default--api--canary',
        dispatchNamespace: 'k1c-default-production',
      });
      expect(dispatch.update).toHaveBeenCalledWith(
        'k1c-default-production',
        'k1c--default--api--canary',
        expect.objectContaining({
          account_id: 'acc-123',
          metadata: expect.objectContaining({
            main_module: 'worker.mjs',
            compatibility_date: '2025-06-01',
          }),
          files: expect.objectContaining({ 'worker.mjs': expect.anything() }),
        }),
      );
      // versions/deployments path must not be used for dispatch-namespace scripts.
      expect(scripts.versions.create).not.toHaveBeenCalled();
      expect(scripts.deployments.create).not.toHaveBeenCalled();
    });

    it('translates 403 from versions.create to AccessDenied ProviderError', async () => {
      const scripts = buildScriptsMock();
      scripts.versions.create.mockRejectedValueOnce({ status: 403, message: 'forbidden' });
      await expect(
        workerProvider.create(buildCtx(scripts), 'default/api', baseProps),
      ).rejects.toMatchObject({ code: 'AccessDenied' });
    });

    it('rolls forward and surfaces deployments.create errors', async () => {
      const scripts = buildScriptsMock();
      scripts.versions.create.mockResolvedValueOnce({ id: 'ver-1' });
      scripts.deployments.create.mockRejectedValueOnce({ status: 503, message: 'svc' });
      await expect(
        workerProvider.create(buildCtx(scripts), 'default/api', baseProps),
      ).rejects.toMatchObject({ code: 'ServiceInternalError', recoverable: true });
    });

    it('throws if versions.create response has no id', async () => {
      const scripts = buildScriptsMock();
      scripts.versions.create.mockResolvedValueOnce({ number: 1 });
      scripts.deployments.create.mockResolvedValue({});
      await expect(
        workerProvider.create(buildCtx(scripts), 'default/api', baseProps),
      ).rejects.toBeDefined();
    });
  });

  describe('update', () => {
    it('uploads a new version and creates a new 100% deployment (cutover semantics)', async () => {
      const scripts = buildScriptsMock();
      scripts.versions.create.mockResolvedValueOnce({ id: 'ver-2' });
      scripts.deployments.create.mockResolvedValueOnce({ id: 'dep-2' });
      await workerProvider.update(
        buildCtx(scripts),
        'k1c--default--api',
        baseProps,
        { ...baseProps, compatibilityDate: '2025-09-01' },
      );
      const meta = scripts.versions.create.mock.calls[0]![1].metadata;
      expect(meta.compatibility_date).toBe('2025-09-01');
      expect(scripts.deployments.create.mock.calls[0]![1].versions).toEqual([
        { version_id: 'ver-2', percentage: 100 },
      ]);
    });
  });

  describe('delete', () => {
    it('calls scripts.delete with script name', async () => {
      const scripts = buildScriptsMock();
      scripts.delete.mockResolvedValueOnce(undefined);
      const result = await workerProvider.delete(buildCtx(scripts), 'k1c--default--api');
      expect(result).toEqual({ kind: 'sync' });
      expect(scripts.delete).toHaveBeenCalledWith('k1c--default--api', {
        account_id: 'acc-123',
      });
    });
  });

  describe('read', () => {
    it('parses entrypointHash back from the content-hash tag', async () => {
      const scripts = buildScriptsMock();
      scripts.scriptAndVersionSettings.get.mockResolvedValueOnce({
        compatibility_date: '2025-06-01',
        bindings: [],
        tags: ['k1c.io/managed-by=k1c', 'k1c.io/content-hash=deadbeef'],
      });
      const result = await workerProvider.read(buildCtx(scripts), 'k1c--default--api');
      expect(result).not.toBe(NotFound);
      const props = result as unknown as Record<string, unknown>;
      expect(props.entrypointHash).toBe('deadbeef');
    });

    it('returns NotFound on 404', async () => {
      const scripts = buildScriptsMock();
      scripts.scriptAndVersionSettings.get.mockRejectedValueOnce({
        status: 404,
        message: 'gone',
      });
      const result = await workerProvider.read(buildCtx(scripts), 'k1c--default--api');
      expect(result).toBe(NotFound);
    });

    it('reconstructs WorkerProperties from settings + bindings', async () => {
      const scripts = buildScriptsMock();
      scripts.scriptAndVersionSettings.get.mockResolvedValueOnce({
        compatibility_date: '2025-06-01',
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true },
        placement: { mode: 'smart' },
        bindings: [
          { type: 'plain_text', name: 'REGION', text: 'weur' },
          { type: 'r2_bucket', name: 'R2_MEDIA', bucket_name: 'k1c-default-media' },
          { type: 'kv_namespace', name: 'KV_CACHE', namespace_id: 'id-1' },
        ],
      });
      const result = await workerProvider.read(buildCtx(scripts), 'k1c--default--api');
      expect(result).not.toBe(NotFound);
      const props = result as unknown as Record<string, unknown>;
      expect(props.compatibilityDate).toBe('2025-06-01');
      expect(props.compatibilityFlags).toEqual(['nodejs_compat']);
      expect(props.observability).toEqual({ enabled: true });
      expect(props.placement).toEqual({ mode: 'smart' });
      expect(props.vars).toEqual({ REGION: 'weur' });
      const bindings = props.bindings as Array<Record<string, string>>;
      expect(bindings).toContainEqual({
        type: 'r2_bucket',
        name: 'R2_MEDIA',
        bucketName: 'k1c-default-media',
      });
      expect(bindings).toContainEqual({
        type: 'kv_namespace',
        name: 'KV_CACHE',
        namespaceId: 'id-1',
      });
    });
  });
});
