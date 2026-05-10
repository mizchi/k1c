import * as k8s from '@kubernetes/client-node';

/** Finalizer string the operator adds to every Cloudflare CRD instance. */
export const K1C_FINALIZER = 'k1c.io/cleanup';

interface CRDPath {
  readonly group: string;
  readonly version: string;
  readonly plural: string;
  readonly namespace: string;
  readonly name: string;
}

/**
 * Idempotently add the `k1c.io/cleanup` finalizer to a CR. Caller passes
 * the current finalizers list so we don't re-patch when nothing would
 * change. JSON-merge-patch keeps other finalizers (e.g. those added by
 * different controllers) intact.
 */
export async function ensureFinalizer(
  customApi: k8s.CustomObjectsApi,
  path: CRDPath,
  current: ReadonlyArray<string>,
): Promise<void> {
  if (current.includes(K1C_FINALIZER)) return;
  const next = [...current, K1C_FINALIZER];
  await customApi.patchNamespacedCustomObject(
    {
      group: path.group,
      version: path.version,
      namespace: path.namespace,
      plural: path.plural,
      name: path.name,
      body: { metadata: { finalizers: next } },
    },
    k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
  );
}

/**
 * Remove our finalizer from the CR. Does nothing if the finalizer
 * isn't present. The CR can then be garbage-collected by k8s once all
 * other finalizers (if any) are also removed.
 */
export async function removeFinalizer(
  customApi: k8s.CustomObjectsApi,
  path: CRDPath,
  current: ReadonlyArray<string>,
): Promise<void> {
  if (!current.includes(K1C_FINALIZER)) return;
  const next = current.filter((f) => f !== K1C_FINALIZER);
  await customApi.patchNamespacedCustomObject(
    {
      group: path.group,
      version: path.version,
      namespace: path.namespace,
      plural: path.plural,
      name: path.name,
      body: { metadata: { finalizers: next } },
    },
    k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
  );
}
