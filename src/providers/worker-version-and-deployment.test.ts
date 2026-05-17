import { describe, expect, it, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workerVersionProvider } from './worker-version.ts';
import { workerDeploymentProvider } from './worker-deployment.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function makeCtx(workers: unknown): ProviderContext {
  return {
    cloudflare: { workers } as unknown as Cloudflare,
    accountId: 'acc',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

describe('workerVersionProvider', () => {
  it('create uploads with workers/tag annotation set to versionTag', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ver-abc' });
    const result = await workerVersionProvider.create(
      makeCtx({ scripts: { versions: { create, get: vi.fn(), list: vi.fn() } } }),
      'default/api-v1',
      {
        scriptName: 'api',
        versionTag: 'v1.0.0',
        message: 'first cut',
        script: {
          scriptName: 'api',
          entrypoint: '/dev/null',
          entrypointContent: 'export default { fetch(){return new Response("ok")} }',
          compatibilityDate: '2025-01-01',
        },
      },
    );
    expect(create).toHaveBeenCalled();
    const [scriptArg, params] = create.mock.calls[0]!;
    expect(scriptArg).toBe('api');
    expect((params as { metadata: { annotations: Record<string, string> } }).metadata.annotations)
      .toEqual({ 'workers/tag': 'v1.0.0', 'workers/message': 'first cut' });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'api::ver-abc' });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const result = await workerVersionProvider.read(
      makeCtx({ scripts: { versions: { get, create: vi.fn(), list: vi.fn() } } }),
      'api::ver-gone',
    );
    expect(result).toBe(NotFound);
  });

  it('update rejects with NotUpdatable so the planner triggers a recreate', async () => {
    await expect(
      workerVersionProvider.update(
        makeCtx({ scripts: { versions: {} } }),
        'api::ver-abc',
        {
          scriptName: 'api',
          versionTag: 'v1',
          script: { scriptName: 'api', entrypoint: '/dev/null', compatibilityDate: '2025-01-01' },
        },
        {
          scriptName: 'api',
          versionTag: 'v1',
          script: { scriptName: 'api', entrypoint: '/dev/null', compatibilityDate: '2025-01-01' },
        },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('delete is a no-op (no Cloudflare endpoint exists)', async () => {
    const result = await workerVersionProvider.delete(
      makeCtx({ scripts: { versions: {} } }),
      'api::ver-abc',
    );
    expect(result).toEqual({ kind: 'sync' });
  });
});

describe('workerDeploymentProvider', () => {
  it('create POSTs a percentage strategy with the version list', async () => {
    const create = vi.fn().mockResolvedValue({});
    const result = await workerDeploymentProvider.create(
      makeCtx({ scripts: { deployments: { create, get: vi.fn() } } }),
      'default/api',
      {
        scriptName: 'api',
        versions: [
          { versionId: 'ver-a', percentage: 90 },
          { versionId: 'ver-b', percentage: 10 },
        ],
        message: 'canary 10%',
      },
    );
    expect(create).toHaveBeenCalledWith('api', {
      account_id: 'acc',
      strategy: 'percentage',
      versions: [
        { version_id: 'ver-a', percentage: 90 },
        { version_id: 'ver-b', percentage: 10 },
      ],
      annotations: { 'workers/message': 'canary 10%' },
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'api' });
  });

  it('read returns the latest deployment + version split', async () => {
    const get = vi.fn().mockResolvedValue({
      deployments: [
        {
          versions: [
            { version_id: 'ver-a', percentage: 100 },
          ],
        },
      ],
    });
    const props = await workerDeploymentProvider.read(
      makeCtx({ scripts: { deployments: { get, create: vi.fn() } } }),
      'api',
    );
    expect(props).toEqual({
      scriptName: 'api',
      versions: [{ versionId: 'ver-a', percentage: 100 }],
    });
  });

  it('read returns NotFound when no deployments exist yet', async () => {
    const get = vi.fn().mockResolvedValue({ deployments: [] });
    const result = await workerDeploymentProvider.read(
      makeCtx({ scripts: { deployments: { get, create: vi.fn() } } }),
      'api',
    );
    expect(result).toBe(NotFound);
  });

  it('equals ignores version-entry order', () => {
    const eq = workerDeploymentProvider.equals!;
    expect(
      eq(
        {
          scriptName: 's',
          versions: [
            { versionId: 'a', percentage: 90 },
            { versionId: 'b', percentage: 10 },
          ],
        },
        {
          scriptName: 's',
          versions: [
            { versionId: 'b', percentage: 10 },
            { versionId: 'a', percentage: 90 },
          ],
        },
      ),
    ).toBe(true);
  });

  it('update POSTs a fresh deployment (no UPDATE endpoint on the SDK)', async () => {
    const create = vi.fn().mockResolvedValue({});
    await workerDeploymentProvider.update(
      makeCtx({ scripts: { deployments: { create, get: vi.fn() } } }),
      'api',
      {
        scriptName: 'api',
        versions: [{ versionId: 'ver-a', percentage: 100 }],
      },
      {
        scriptName: 'api',
        versions: [
          { versionId: 'ver-a', percentage: 50 },
          { versionId: 'ver-b', percentage: 50 },
        ],
      },
    );
    expect(create).toHaveBeenCalled();
    const [, params] = create.mock.calls[0]!;
    expect((params as { versions: unknown }).versions).toEqual([
      { version_id: 'ver-a', percentage: 50 },
      { version_id: 'ver-b', percentage: 50 },
    ]);
  });
});
