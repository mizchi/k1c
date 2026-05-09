import { describe, it, expect } from 'vitest';
import { plan } from '../../src/reconciler/plan.ts';
import { apply } from '../../src/reconciler/apply.ts';
import { createDefaultRegistry } from '../../src/providers/index.ts';
import { placeholder } from '../../src/reconciler/placeholders.ts';
import type { DesiredResource } from '../../src/reconciler/types.ts';
import { buildE2EContext, e2eEnabled, e2eName, safeCleanup } from './_harness.ts';

const RUN_E2E = e2eEnabled();

/**
 * The motivation here is the placeholder resolution layer: lower emits
 * `<resolved-at-apply:KVNamespace:<label>>` for KV bindings, and the apply
 * step substitutes the real namespace_id between the KV's create and the
 * Worker's create. Mocked tests prove the substitution wires through
 * correctly; only a real apply against Cloudflare proves the substituted
 * id is what the Workers Scripts API actually expects.
 */
describe.skipIf(!RUN_E2E)('e2e: Worker with KV binding (resolution layer)', () => {
  it('creates a KV namespace, then a Worker that binds it via placeholder, then tears both down', async () => {
    const { providerCtx } = buildE2EContext();
    const registry = createDefaultRegistry();

    const ns = 'default';
    const kvName = e2eName('kv');
    const workerName = e2eName('worker');
    const kvLabel = `${ns}/${kvName}`;
    const workerLabel = `${ns}/${workerName}`;

    const kvDesired: DesiredResource = {
      resourceType: 'KVNamespace',
      ref: {
        apiVersion: 'cloudflare.k1c.io/v1alpha1',
        kind: 'KVNamespace',
        namespace: ns,
        name: kvName,
      },
      label: kvLabel,
      properties: { title: `k1c/${ns}/${kvName}` },
    };

    const workerScriptName = `k1c--${ns}--${workerName}`;
    const workerSource = 'export default { async fetch() { return new Response("ok"); } };';
    const workerDesired: DesiredResource = {
      resourceType: 'Worker',
      ref: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        namespace: ns,
        name: workerName,
      },
      label: workerLabel,
      properties: {
        scriptName: workerScriptName,
        entrypoint: '<e2e:inline>',
        entrypointContent: workerSource,
        compatibilityDate: '2025-01-01',
        bindings: [
          {
            type: 'kv_namespace',
            name: 'CACHE',
            namespaceId: placeholder('KVNamespace', kvLabel),
          },
        ],
      },
      dependsOn: [
        {
          apiVersion: 'cloudflare.k1c.io/v1alpha1',
          kind: 'KVNamespace',
          namespace: ns,
          name: kvName,
        },
      ],
    };

    let kvNativeId: string | undefined;
    let workerNativeId: string | undefined;
    try {
      const p = await plan([kvDesired, workerDesired], registry, providerCtx);
      const report = await apply(p, registry, providerCtx, { pollIntervalMs: 0 });
      expect(report.failed).toBe(0);
      expect(report.succeeded).toBeGreaterThanOrEqual(2);

      // Identify what was created so we can clean up regardless of plan ordering.
      for (const r of report.results) {
        if (r.status !== 'succeeded') continue;
        if (r.op.kind !== 'create') continue;
        if (r.op.resourceType === 'KVNamespace') kvNativeId = r.nativeId;
        if (r.op.resourceType === 'Worker') workerNativeId = r.nativeId;
      }
      expect(kvNativeId).toBeDefined();
      expect(workerNativeId).toBeDefined();
    } finally {
      // Reverse-topo cleanup: Worker first (since it bound the KV), then KV.
      if (workerNativeId !== undefined) {
        await safeCleanup(() =>
          registry.get('Worker').delete(providerCtx, workerNativeId!),
        );
      }
      if (kvNativeId !== undefined) {
        await safeCleanup(() =>
          registry.get('KVNamespace').delete(providerCtx, kvNativeId!),
        );
      }
    }
  });
});
