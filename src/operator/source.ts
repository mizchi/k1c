import * as k8s from '@kubernetes/client-node';
import type { K1cResource } from '../manifest/types.ts';
import { listKinds } from '../manifest/schemas.ts';
import { k1cResourceSchema } from '../manifest/schemas.ts';

/**
 * Operator-side input source: list every k1c-managed resource currently in
 * etcd, returning a flat K1cResource[] that the existing lower / plan /
 * apply pipeline can consume verbatim.
 *
 * Two categories of kinds:
 *
 *   - Standard k8s kinds (Deployment / Service / ConfigMap / Secret / Ingress
 *     / StatefulSet / CronJob / Job / Namespace) — fetched via the typed APIs
 *     in @kubernetes/client-node. Filtered by an opt-in label so the operator
 *     only touches workloads that explicitly want k1c reconciliation.
 *
 *   - Cloudflare CRDs under `cloudflare.k1c.io/v1alpha1` (R2Bucket, KVNamespace,
 *     ...) — fetched via the dynamic CustomObjectsApi. No label filter; their
 *     mere presence means the user wants Cloudflare to host them.
 *
 * Each raw k8s object is fed back through `k1cResourceSchema.safeParse` so it
 * shares the validation pass with `parseManifest`. Anything that fails to
 * parse is dropped with a warning callback so a single malformed resource
 * does not fail the whole reconcile.
 */

const CLOUDFLARE_GROUP = 'cloudflare.k1c.io';
const CLOUDFLARE_VERSION = 'v1alpha1';

/** Kinds the operator should look up via the dynamic CRD API. */
const CLOUDFLARE_KINDS_BY_PLURAL: Readonly<Record<string, string>> = {
  r2buckets: 'R2Bucket',
  kvnamespaces: 'KVNamespace',
  d1databases: 'D1Database',
  hyperdrives: 'Hyperdrive',
  queues: 'Queue',
  vectorizes: 'Vectorize',
  dnsrecords: 'DNSRecord',
  dispatchnamespaces: 'DispatchNamespace',
  logpushjobs: 'LogpushJob',
  telemetrystacks: 'TelemetryStack',
  accessapplications: 'AccessApplication',
  accesspolicies: 'AccessPolicy',
  cacherules: 'CacheRule',
  transformrules: 'TransformRule',
  urirewriterules: 'URIRewriteRule',
  responseheaderrules: 'ResponseHeaderRule',
  wafcustomrules: 'WAFCustomRule',
  wafmanagedrulesets: 'WAFManagedRuleset',
  ratelimitrules: 'RateLimitRule',
  customhostnames: 'CustomHostname',
  emailroutingrules: 'EmailRoutingRule',
};

/** Opt-in label that gates Deployment / Service / ConfigMap / etc. for k1c. */
export const MANAGED_LABEL = 'k1c.io/managed';

export interface SourceOptions {
  readonly kc: k8s.KubeConfig;
  /** Restrict to a single namespace; defaults to "all namespaces". */
  readonly namespace?: string;
  /** Called when a resource fails parse. Defaults to console.warn. */
  readonly onWarning?: (msg: string) => void;
}

export async function listManagedResources(
  options: SourceOptions,
): Promise<ReadonlyArray<K1cResource>> {
  const out: K1cResource[] = [];
  const onWarning = options.onWarning ?? ((m) => console.warn(m));
  const ns = options.namespace;

  const customApi = options.kc.makeApiClient(k8s.CustomObjectsApi);
  const coreApi = options.kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = options.kc.makeApiClient(k8s.AppsV1Api);
  const batchApi = options.kc.makeApiClient(k8s.BatchV1Api);
  const netApi = options.kc.makeApiClient(k8s.NetworkingV1Api);

  // ---- Cloudflare CRDs (no label filter — presence implies management) ----
  for (const [plural, kind] of Object.entries(CLOUDFLARE_KINDS_BY_PLURAL)) {
    if (!listKinds().includes(kind as never)) continue;
    try {
      const resp = ns
        ? await customApi.listNamespacedCustomObject({
            group: CLOUDFLARE_GROUP,
            version: CLOUDFLARE_VERSION,
            namespace: ns,
            plural,
          })
        : await customApi.listClusterCustomObject({
            group: CLOUDFLARE_GROUP,
            version: CLOUDFLARE_VERSION,
            plural,
          });
      const items = (resp as { items?: ReadonlyArray<unknown> }).items ?? [];
      for (const raw of items) {
        const normalized = normalize(raw, kind, `${CLOUDFLARE_GROUP}/${CLOUDFLARE_VERSION}`);
        const parsed = k1cResourceSchema.safeParse(normalized);
        if (!parsed.success) {
          onWarning(`skipping ${kind} (validation failed): ${parsed.error.issues[0]?.message}`);
          continue;
        }
        out.push(parsed.data as K1cResource);
      }
    } catch (e) {
      // CRD not registered on this cluster yet; treat as empty.
      const status = (e as { code?: number }).code;
      if (status !== 404) onWarning(`listing ${plural} failed: ${(e as Error).message ?? e}`);
    }
  }

  // ---- Standard k8s kinds (label-gated) ----
  const labelSel = `${MANAGED_LABEL}=true`;

  // Deployments
  await collectStandard(
    'Deployment',
    'apps/v1',
    () =>
      ns
        ? appsApi.listNamespacedDeployment({ namespace: ns, labelSelector: labelSel })
        : appsApi.listDeploymentForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  // StatefulSets
  await collectStandard(
    'StatefulSet',
    'apps/v1',
    () =>
      ns
        ? appsApi.listNamespacedStatefulSet({ namespace: ns, labelSelector: labelSel })
        : appsApi.listStatefulSetForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  // ConfigMaps + Secrets
  await collectStandard(
    'ConfigMap',
    'v1',
    () =>
      ns
        ? coreApi.listNamespacedConfigMap({ namespace: ns, labelSelector: labelSel })
        : coreApi.listConfigMapForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  await collectStandard(
    'Secret',
    'v1',
    () =>
      ns
        ? coreApi.listNamespacedSecret({ namespace: ns, labelSelector: labelSel })
        : coreApi.listSecretForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  // Services
  await collectStandard(
    'Service',
    'v1',
    () =>
      ns
        ? coreApi.listNamespacedService({ namespace: ns, labelSelector: labelSel })
        : coreApi.listServiceForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  // CronJobs + Jobs
  await collectStandard(
    'CronJob',
    'batch/v1',
    () =>
      ns
        ? batchApi.listNamespacedCronJob({ namespace: ns, labelSelector: labelSel })
        : batchApi.listCronJobForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  await collectStandard(
    'Job',
    'batch/v1',
    () =>
      ns
        ? batchApi.listNamespacedJob({ namespace: ns, labelSelector: labelSel })
        : batchApi.listJobForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );
  // Ingress
  await collectStandard(
    'Ingress',
    'networking.k8s.io/v1',
    () =>
      ns
        ? netApi.listNamespacedIngress({ namespace: ns, labelSelector: labelSel })
        : netApi.listIngressForAllNamespaces({ labelSelector: labelSel }),
    onWarning,
    out,
  );

  return out;
}

async function collectStandard(
  kind: string,
  apiVersion: string,
  list: () => Promise<{ items?: ReadonlyArray<unknown> } | unknown>,
  onWarning: (m: string) => void,
  out: K1cResource[],
): Promise<void> {
  let resp;
  try {
    resp = (await list()) as { items?: ReadonlyArray<unknown> };
  } catch (e) {
    onWarning(`listing ${kind} failed: ${(e as Error).message ?? e}`);
    return;
  }
  const items = resp.items ?? [];
  for (const raw of items) {
    const normalized = normalize(raw, kind, apiVersion);
    const parsed = k1cResourceSchema.safeParse(normalized);
    if (!parsed.success) {
      onWarning(`skipping ${kind} (validation failed): ${parsed.error.issues[0]?.message}`);
      continue;
    }
    out.push(parsed.data as K1cResource);
  }
}

/**
 * Strip server-side fields the k8s API adds (resourceVersion, uid,
 * creationTimestamp, managedFields, generation, status, ...) so the object
 * round-trips cleanly through our manifest schema, which is intentionally
 * stricter than the upstream PodSpec / etc.
 *
 * Falls back to `kind` / `apiVersion` from the discovery side when the API
 * response omits them (server-side serialization sometimes drops them).
 */
function normalize(
  raw: unknown,
  kindFallback: string,
  apiVersionFallback: string,
): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const meta = obj['metadata'] as Record<string, unknown> | undefined;
  const cleanMeta: Record<string, unknown> = {};
  if (meta) {
    for (const k of ['name', 'namespace', 'labels', 'annotations']) {
      if (meta[k] !== undefined) cleanMeta[k] = meta[k];
    }
  }
  const out: Record<string, unknown> = {
    apiVersion: obj['apiVersion'] ?? apiVersionFallback,
    kind: obj['kind'] ?? kindFallback,
    metadata: cleanMeta,
  };
  if (obj['spec'] !== undefined) out['spec'] = obj['spec'];
  if (obj['data'] !== undefined) out['data'] = obj['data'];
  if (obj['stringData'] !== undefined) out['stringData'] = obj['stringData'];
  if (obj['type'] !== undefined && obj['kind'] === 'Secret') out['type'] = obj['type'];
  return out;
}
