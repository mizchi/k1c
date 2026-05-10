import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workerProvider } from './worker.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface ScriptsMock {
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly settings: { readonly get: ReturnType<typeof vi.fn> };
  readonly scriptAndVersionSettings: { readonly get: ReturnType<typeof vi.fn> };
  readonly schedules: {
    readonly update: ReturnType<typeof vi.fn>;
    readonly get: ReturnType<typeof vi.fn>;
  };
}

interface DispatchScriptsMock {
  readonly update: ReturnType<typeof vi.fn>;
}

function buildScriptsMock(): ScriptsMock {
  return {
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    settings: { get: vi.fn() },
    scriptAndVersionSettings: { get: vi.fn() },
    schedules: {
      update: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockRejectedValue({ status: 404 }),
    },
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

/**
 * The provider passes metadata as a `Blob` (application/json) so the
 * Cloudflare SDK's multipart serializer keeps it as a single part
 * instead of decomposing the object into `metadata[key]=value` form
 * fields. Tests that want to inspect the metadata should call this
 * helper rather than reading `.metadata` directly.
 */
async function readMetadata(spy: { mock: { calls: unknown[][] } }): Promise<Record<string, unknown>> {
  const params = spy.mock.calls[0]![1] as { metadata: Blob };
  return JSON.parse(await params.metadata.text());
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
      scripts.update.mockResolvedValue({});
      return scripts;
    }

    it('uploads main_module + compatibility_date in metadata', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      const meta = await readMetadata(scripts.update);
      expect(scripts.update).toHaveBeenCalledWith(
        'k1c--default--api',
        expect.objectContaining({ account_id: 'acc-123' }),
      );
      expect(meta).toMatchObject({
        main_module: 'worker.mjs',
        compatibility_date: '2025-06-01',
      });
    });

    it('serialises metadata as a single application/json Blob', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      const blob = scripts.update.mock.calls[0]![1].metadata as Blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/json');
    });

    it('passes the entrypoint file as a multipart part keyed by main_module name', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', baseProps);
      const params = scripts.update.mock.calls[0]![1] as Record<string, unknown>;
      expect(params['worker.mjs']).toBeDefined();
    });

    it('translates vars to plain_text bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        vars: { LOG_LEVEL: 'info', REGION: 'weur' },
      });
      const bindings = (await readMetadata(scripts.update)).bindings as Array<Record<string, string>>;
      expect(bindings).toContainEqual({ type: 'plain_text', name: 'LOG_LEVEL', text: 'info' });
      expect(bindings).toContainEqual({ type: 'plain_text', name: 'REGION', text: 'weur' });
    });

    it('translates secrets to secret_text bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        secrets: { TOKEN: 'shh' },
      });
      const bindings = (await readMetadata(scripts.update)).bindings as Array<Record<string, string>>;
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
      const bindings = (await readMetadata(scripts.update)).bindings as Array<Record<string, string>>;
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
      const tags = (await readMetadata(scripts.update)).tags as string[];
      expect(tags).toContain('k1c.io/managed-by=k1c');
    });

    it('embeds the entrypointHash into metadata.tags as k1c.io/content-hash=...', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        entrypointHash: 'abcdef0123',
      });
      const tags = (await readMetadata(scripts.update)).tags as string[];
      expect(tags).toContain('k1c.io/content-hash=abcdef0123');
    });

    it('syncs cron triggers via schedules.update when cronSchedules is set', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/cleanup', {
        ...baseProps,
        cronSchedules: ['0 3 * * *', '*/30 * * * *'],
      });
      expect(scripts.schedules.update).toHaveBeenCalledWith('k1c--default--api', {
        account_id: 'acc-123',
        body: [{ cron: '0 3 * * *' }, { cron: '*/30 * * * *' }],
      });
    });

    it('emits a DO self-binding and migrations.new_sqlite_classes for durableObjectClasses', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/chatroom', {
        ...baseProps,
        scriptName: 'k1c--default--chatroom',
        durableObjectClasses: ['Chatroom'],
      });
      const meta = await readMetadata(scripts.update);
      const bindings = meta.bindings as Array<Record<string, string>>;
      expect(bindings).toContainEqual({
        type: 'durable_object_namespace',
        name: 'Chatroom',
        class_name: 'Chatroom',
      });
      const migrations = meta.migrations as Record<string, unknown>;
      expect(migrations.new_sqlite_classes).toEqual(['Chatroom']);
      const tags = meta.tags as string[];
      expect(tags).toContain('k1c.io/do-classes=Chatroom');
    });

    it('parses durableObjectClasses back from the do-classes tag on read', async () => {
      const scripts = buildScriptsMock();
      scripts.scriptAndVersionSettings.get.mockResolvedValueOnce({
        compatibility_date: '2025-06-01',
        bindings: [],
        tags: ['k1c.io/managed-by=k1c', 'k1c.io/do-classes=Chatroom,Lobby'],
      });
      const result = await workerProvider.read(buildCtx(scripts), 'k1c--default--chatroom');
      expect(result).not.toBe(NotFound);
      const props = result as unknown as Record<string, unknown>;
      expect(props.durableObjectClasses).toEqual(['Chatroom', 'Lobby']);
    });

    it('clears cron triggers when cronSchedules is empty (CronJob suspend)', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        cronSchedules: [],
      });
      expect(scripts.schedules.update).toHaveBeenCalledWith('k1c--default--api', {
        account_id: 'acc-123',
        body: [],
      });
    });

    it('passes observability and placement when set', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        observability: { enabled: true },
        placement: { mode: 'smart' },
      });
      const meta = await readMetadata(scripts.update);
      expect(meta.observability).toEqual({ enabled: true });
      expect(meta.placement).toEqual({ mode: 'smart' });
    });

    it('uploads compatibility_flags when provided', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/api', {
        ...baseProps,
        compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
      });
      const meta = await readMetadata(scripts.update);
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
      expect(scripts.update).toHaveBeenCalled();
    });

    it('translates dispatch_namespace bindings', async () => {
      const scripts = setup();
      await workerProvider.create(buildCtx(scripts), 'default/dispatcher', {
        ...baseProps,
        bindings: [
          { type: 'dispatch_namespace', name: 'NAMESPACE', dispatchNamespace: 'k1c-default-prod' },
        ],
      });
      const bindings = (await readMetadata(scripts.update)).bindings as Array<
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
      const meta = JSON.parse(
        await (dispatch.update.mock.calls[0]![2] as { metadata: Blob }).metadata.text(),
      );
      expect(meta).toMatchObject({
        main_module: 'worker.mjs',
        compatibility_date: '2025-06-01',
      });
      expect(dispatch.update).toHaveBeenCalledWith(
        'k1c-default-production',
        'k1c--default--api--canary',
        expect.objectContaining({
          account_id: 'acc-123',
          files: expect.objectContaining({ 'worker.mjs': expect.anything() }),
        }),
      );
      // The dispatch-namespace path uses workersForPlatforms.dispatch.scripts.update,
      // not the regular workers.scripts.update endpoint.
      expect(scripts.update).not.toHaveBeenCalled();
    });

    it('translates 403 from scripts.update to AccessDenied ProviderError', async () => {
      const scripts = buildScriptsMock();
      scripts.update.mockRejectedValueOnce({ status: 403, message: 'forbidden' });
      await expect(
        workerProvider.create(buildCtx(scripts), 'default/api', baseProps),
      ).rejects.toMatchObject({ code: 'AccessDenied' });
    });
  });

  describe('update', () => {
    it('PUTs the latest content + metadata via scripts.update (cutover semantics)', async () => {
      const scripts = buildScriptsMock();
      scripts.update.mockResolvedValueOnce({});
      await workerProvider.update(
        buildCtx(scripts),
        'k1c--default--api',
        baseProps,
        { ...baseProps, compatibilityDate: '2025-09-01' },
      );
      const meta = await readMetadata(scripts.update);
      expect(meta.compatibility_date).toBe('2025-09-01');
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
    it('parses cronSchedules back via schedules.get', async () => {
      const scripts = buildScriptsMock();
      scripts.scriptAndVersionSettings.get.mockResolvedValueOnce({
        compatibility_date: '2025-06-01',
        bindings: [],
      });
      scripts.schedules.get.mockResolvedValueOnce({
        schedules: [{ cron: '0 3 * * *' }, { cron: '*/30 * * * *' }],
      });
      const result = await workerProvider.read(buildCtx(scripts), 'k1c--default--cleanup');
      expect(result).not.toBe(NotFound);
      const props = result as unknown as Record<string, unknown>;
      expect(props.cronSchedules).toEqual(['0 3 * * *', '*/30 * * * *']);
    });

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

  describe('equals (content-only change detection)', () => {
    const baseProps = {
      scriptName: 'k1c--default--api',
      entrypoint: '<read-from-cluster>',
      compatibilityDate: '2025-01-01',
      entrypointHash: 'abc123',
    };

    it('treats prior (read-from-cluster) and desired (file path) as equal when hash matches', () => {
      expect(
        workerProvider.equals!(
          { ...baseProps, entrypoint: '<read-from-cluster>' },
          { ...baseProps, entrypoint: './dist/worker.js' },
        ),
      ).toBe(true);
    });

    it('treats different entrypointHash as a real difference (content drift)', () => {
      expect(
        workerProvider.equals!(
          { ...baseProps, entrypointHash: 'abc' },
          { ...baseProps, entrypointHash: 'def' },
        ),
      ).toBe(false);
    });

    it('ignores `secrets` since the API never returns them', () => {
      expect(
        workerProvider.equals!(
          { ...baseProps, secrets: {} },
          { ...baseProps, secrets: { TOKEN: 's3cret' } },
        ),
      ).toBe(true);
    });

    it('still detects binding changes', () => {
      expect(
        workerProvider.equals!(
          { ...baseProps, bindings: [{ type: 'kv_namespace', name: 'A', namespaceId: 'x' }] },
          { ...baseProps, bindings: [{ type: 'kv_namespace', name: 'A', namespaceId: 'y' }] },
        ),
      ).toBe(false);
    });
  });
});
