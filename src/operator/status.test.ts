import { describe, expect, it } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { writeStatus } from './status.ts';
import type { ApplyReport, OperationResult } from '../reconciler/types.ts';

interface PatchCall {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: { status: { conditions: ReadonlyArray<Record<string, unknown>> } };
}

function fakeKubeConfig(calls: PatchCall[], errs: ReadonlyArray<{ code?: number; message?: string }> = []): k8s.KubeConfig {
  let errIdx = 0;
  const fakeCustomApi = {
    patchNamespacedCustomObjectStatus: async (param: PatchCall) => {
      const err = errs[errIdx];
      errIdx += 1;
      if (err) throw err;
      calls.push(param);
      return {};
    },
  };
  // Bypass the real KubeConfig — only `makeApiClient(CustomObjectsApi)` is touched.
  return {
    makeApiClient(klass: unknown) {
      if (klass === k8s.CustomObjectsApi) return fakeCustomApi;
      throw new Error(`unexpected client request: ${String(klass)}`);
    },
  } as unknown as k8s.KubeConfig;
}

function result(
  resourceType: string,
  label: string,
  status: 'succeeded' | 'failed' | 'skipped',
  errMessage?: string,
): OperationResult {
  return {
    op: {
      kind: 'create',
      resourceType,
      ref: {
        apiVersion: 'cloudflare.k1c.io/v1alpha1',
        kind: resourceType as never,
        namespace: 'ns',
        name: 'n',
      },
      label,
      properties: {},
    },
    status,
    ...(errMessage
      ? { error: { code: 'NotFound' as const, recoverable: false, message: errMessage } }
      : {}),
  };
}

function report(results: ReadonlyArray<OperationResult>): ApplyReport {
  let s = 0,
    f = 0,
    sk = 0;
  for (const r of results) {
    if (r.status === 'succeeded') s += 1;
    else if (r.status === 'failed') f += 1;
    else sk += 1;
  }
  return { results, succeeded: s, failed: f, skipped: sk };
}

describe('writeStatus', () => {
  it('patches Ready=True for successful Cloudflare CRDs', async () => {
    const calls: PatchCall[] = [];
    await writeStatus({
      kc: fakeKubeConfig(calls),
      report: report([result('R2Bucket', 'default/media', 'succeeded')]),
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.plural).toBe('r2buckets');
    expect(c.namespace).toBe('default');
    expect(c.name).toBe('media');
    const cond = c.body.status.conditions[0]!;
    expect(cond['type']).toBe('Ready');
    expect(cond['status']).toBe('True');
    expect(cond['reason']).toBe('Reconciled');
  });

  it('patches Ready=False with the first error message on failure', async () => {
    const calls: PatchCall[] = [];
    await writeStatus({
      kc: fakeKubeConfig(calls),
      report: report([
        result('KVNamespace', 'app/cache', 'failed', 'Cloudflare API: 404 Not Found'),
      ]),
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.plural).toBe('kvnamespaces');
    const cond = c.body.status.conditions[0]!;
    expect(cond['status']).toBe('False');
    expect(cond['reason']).toBe('ReconcileFailed');
    expect(cond['message']).toContain('Cloudflare API: 404 Not Found');
  });

  it('skips non-Cloudflare resource types (Worker, Workflow, ConfigMap, ...)', async () => {
    const calls: PatchCall[] = [];
    await writeStatus({
      kc: fakeKubeConfig(calls),
      report: report([
        result('Worker', 'default/api', 'succeeded'),
        result('Workflow', 'default/backfill', 'succeeded'),
        result('ConfigMap', 'default/cfg', 'succeeded'),
      ]),
    });
    expect(calls).toHaveLength(0);
  });

  it('aggregates multiple ops sharing the same CRD instance into one patch', async () => {
    const calls: PatchCall[] = [];
    await writeStatus({
      kc: fakeKubeConfig(calls),
      report: report([
        result('TelemetryStack', 'observability/main', 'succeeded'),
        result('TelemetryStack', 'observability/main', 'succeeded'),
      ]),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.status.conditions[0]!['message']).toMatch(/2 ok/);
  });

  it('treats 404 as a benign race (deleted between list and patch)', async () => {
    const calls: PatchCall[] = [];
    const warns: string[] = [];
    await writeStatus({
      kc: fakeKubeConfig(calls, [{ code: 404, message: 'not found' }]),
      report: report([result('R2Bucket', 'default/gone', 'succeeded')]),
      onWarning: (m) => warns.push(m),
    });
    expect(calls).toHaveLength(0);
    expect(warns).toEqual([]);
  });

  it('treats 405 as missing /status subresource and skips silently', async () => {
    const warns: string[] = [];
    await writeStatus({
      kc: fakeKubeConfig([], [{ code: 405, message: 'method not allowed' }]),
      report: report([result('R2Bucket', 'default/legacy', 'succeeded')]),
      onWarning: (m) => warns.push(m),
    });
    expect(warns).toEqual([]);
  });
});
