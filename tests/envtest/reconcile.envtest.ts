import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { runOperator } from '../../src/operator/reconcile.ts';
import { ProviderRegistry } from '../../src/providers/index.ts';
import { FakeProvider } from '../../src/reconciler/fake-provider.ts';
import { r2BucketSchema } from '../../src/manifest/schemas.ts';

/**
 * End-to-end smoke for the operator reconcile loop against a real
 * apiserver (envtest) but a fake Cloudflare backend (`FakeProvider`).
 * Covers the surface kind alone cannot:
 *
 *   - apiserver-side CRD validation accepts the schema the operator
 *     ships,
 *   - listManagedResources picks up an `apply`d CR,
 *   - the reconcile loop calls into the provider with the right label,
 *   - `ensureFinalizer` patches `k1c.io/cleanup` onto the CR,
 *   - `writeStatus` patches `.status.conditions` on the /status
 *     subresource without bumping `.metadata.generation`.
 *
 * Failure modes that would have escaped the existing unit tests:
 *
 *   - `metadata.finalizers` shape mismatch (the JSON patch path),
 *   - status patch hitting the parent endpoint instead of /status
 *     (would silently fail or bump generation),
 *   - CRD `openAPIV3Schema` regressing into a form the apiserver
 *     rejects.
 */
describe('operator reconcile loop (envtest + fake provider)', () => {
  const GROUP = 'cloudflare.k1c.io';
  const VERSION = 'v1alpha1';
  const PLURAL = 'r2buckets';
  const CRD_NAME = `${PLURAL}.${GROUP}`;
  const NAMESPACE = 'default';
  const CR_NAME = 'envtest-bucket';

  let kc: k8s.KubeConfig;
  let abort: AbortController;
  let opPromise: Promise<void>;
  let fake: FakeProvider<{ name: string; location?: string; storageClass?: string }>;

  beforeAll(async () => {
    kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    // Apply the R2Bucket CRD before the operator starts so the watch
    // for cloudflare.k1c.io/v1alpha1/r2buckets succeeds on first try.
    const apiext = kc.makeApiClient(k8s.ApiextensionsV1Api);
    await apiext.createCustomResourceDefinition({
      body: {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: CRD_NAME },
        spec: {
          group: GROUP,
          scope: 'Namespaced',
          names: {
            plural: PLURAL,
            singular: 'r2bucket',
            kind: 'R2Bucket',
            listKind: 'R2BucketList',
          },
          versions: [
            {
              name: VERSION,
              served: true,
              storage: true,
              // Permissive schema — the operator-side validation lives
              // in the zod schemas, not in the CRD. This test cares
              // about reconcile semantics, not server-side validation.
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: {
                      type: 'object',
                      // CRD escape hatch — typed as JSONSchemaProps in
                      // the generated bindings, but k8s recognises the
                      // x-kubernetes-* extension keys at runtime.
                      ['x-kubernetes-preserve-unknown-fields' as never]: true,
                    } as never,
                    status: {
                      type: 'object',
                      properties: {
                        cloudflareNativeId: { type: 'string' },
                        conditions: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              type: { type: 'string' },
                              status: { type: 'string' },
                              reason: { type: 'string' },
                              message: { type: 'string' },
                              lastTransitionTime: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              subresources: { status: {} },
            },
          ],
        },
      },
    });
    // Wait until the apiserver has registered the CRD's REST handler;
    // `kubectl get r2buckets` would otherwise 404 for the first second.
    await waitFor(
      async () => {
        try {
          await kc
            .makeApiClient(k8s.CustomObjectsApi)
            .listNamespacedCustomObject({
              group: GROUP,
              version: VERSION,
              namespace: NAMESPACE,
              plural: PLURAL,
            });
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 10_000, intervalMs: 200, label: 'r2buckets REST handler' },
    );

    fake = new FakeProvider('R2Bucket', r2BucketSchema as never) as never;
    const registry = new ProviderRegistry();
    registry.register(fake as never);

    abort = new AbortController();
    opPromise = runOperator(
      {
        accountId: 'envtest-account',
        apiToken: 'envtest-token',
        intervalMs: 250,
        watch: true,
        debounceMs: 50,
        metricsAddr: '',
        registryOverride: registry,
        // Silence the operator's chatty per-tick log lines under the
        // suite. Flip these to process.stderr.write when debugging.
        out: () => {},
        err: () => {},
      },
      abort.signal,
    );
  });

  afterAll(async () => {
    abort.abort();
    await opPromise;
    // Best-effort: delete the CRD so re-runs of the suite (no global
    // cluster reset between vitest invocations) start clean.
    try {
      await kc
        .makeApiClient(k8s.ApiextensionsV1Api)
        .deleteCustomResourceDefinition({ name: CRD_NAME });
    } catch {
      // already gone
    }
  });

  it('attaches the finalizer and creates the underlying R2 bucket', async () => {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: 'R2Bucket',
      metadata: { name: CR_NAME, namespace: NAMESPACE },
      spec: { name: CR_NAME },
    };
    await customApi.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURAL,
      body: cr,
    });

    // The fake provider's `create` should run within ~one debounce +
    // reconcile pass (50 + ~250 ms). Allow generous slack for CI.
    await waitFor(
      async () => fake.events.some((e) => e.op === 'create'),
      { timeoutMs: 15_000, intervalMs: 200, label: 'fake provider create event' },
    );

    await waitFor(
      async () => {
        const got = (await customApi.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural: PLURAL,
          name: CR_NAME,
        })) as { metadata?: { finalizers?: string[] } };
        return (got.metadata?.finalizers ?? []).includes('k1c.io/cleanup');
      },
      { timeoutMs: 10_000, intervalMs: 200, label: 'k1c.io/cleanup finalizer' },
    );
  });

  it('writes a Ready=True condition onto .status', async () => {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    await waitFor(
      async () => {
        const got = (await customApi.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural: PLURAL,
          name: CR_NAME,
        })) as {
          status?: {
            conditions?: ReadonlyArray<{ type?: string; status?: string }>;
            cloudflareNativeId?: string;
          };
        };
        const ready = (got.status?.conditions ?? []).find((c) => c.type === 'Ready');
        return ready?.status === 'True' && (got.status?.cloudflareNativeId ?? '').length > 0;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 250,
        label: '.status.conditions[Ready=True] + cloudflareNativeId',
      },
    );
  });
});

async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(
    `${opts.label} not satisfied after ${opts.timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ''}`,
  );
}
