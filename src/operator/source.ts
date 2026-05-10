import * as k8s from '@kubernetes/client-node';
import type { K1cResource } from '../manifest/types.ts';
import { listKinds } from '../manifest/schemas.ts';
import { k1cResourceSchema } from '../manifest/schemas.ts';

/**
 * Operator-side input source: list every k1c-managed resource currently in
 * etcd, returning a `ManagedResource[]` with both the parsed K1cResource
 * (for the lower / plan / apply pipeline) and a sidecar of raw k8s
 * metadata fields the operator needs for the finalizer flow
 * (deletionTimestamp, finalizers list, persisted nativeId).
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

export interface ManagedResource {
  readonly resource: K1cResource;
  readonly meta: {
    /** API path components for finalizer patches (CRDs only). Undefined for label-gated standard kinds. */
    readonly crd?: { readonly plural: string; readonly group: string; readonly version: string };
    /** ISO timestamp when k8s starts the deletion handshake. */
    readonly deletionTimestamp?: string;
    readonly finalizers: ReadonlyArray<string>;
    /** Cloudflare native id, persisted by `writeNativeIds`. */
    readonly nativeIdFromStatus?: string;
  };
}

export interface SourceOptions {
  readonly kc: k8s.KubeConfig;
  /** Restrict to a single namespace; defaults to "all namespaces". */
  readonly namespace?: string;
  /** Called when a resource fails parse. Defaults to console.warn. */
  readonly onWarning?: (msg: string) => void;
}

export async function listManagedResources(
  options: SourceOptions,
): Promise<ReadonlyArray<ManagedResource>> {
  const out: ManagedResource[] = [];
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
        const enriched = collect(raw, kind, `${CLOUDFLARE_GROUP}/${CLOUDFLARE_VERSION}`, {
          plural,
          group: CLOUDFLARE_GROUP,
          version: CLOUDFLARE_VERSION,
        });
        if (enriched === null) {
          onWarning(`skipping ${kind} (validation failed)`);
          continue;
        }
        out.push(enriched);
      }
    } catch (e) {
      // CRD not registered on this cluster yet; treat as empty.
      const status = (e as { code?: number }).code;
      if (status !== 404) onWarning(`listing ${plural} failed: ${(e as Error).message ?? e}`);
    }
  }

  // ---- Standard k8s kinds (label-gated) ----
  const labelSel = `${MANAGED_LABEL}=true`;

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
  out: ManagedResource[],
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
    const enriched = collect(raw, kind, apiVersion, undefined);
    if (enriched === null) {
      onWarning(`skipping ${kind} (validation failed)`);
      continue;
    }
    out.push(enriched);
  }
}

interface CRDPath {
  readonly plural: string;
  readonly group: string;
  readonly version: string;
}

/**
 * Strip server-side fields (resourceVersion, uid, managedFields, ...) but
 * preserve the bits the operator's finalizer flow cares about
 * (deletionTimestamp, finalizers, status.cloudflareNativeId). Then validate
 * the spec/data shape against `k1cResourceSchema` and bundle the parsed
 * resource with its sidecar metadata.
 */
function collect(
  raw: unknown,
  kindFallback: string,
  apiVersionFallback: string,
  crd: CRDPath | undefined,
): ManagedResource | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const metaIn = (obj['metadata'] as Record<string, unknown> | undefined) ?? {};
  const cleanMeta: Record<string, unknown> = {};
  for (const k of ['name', 'namespace', 'labels', 'annotations']) {
    if (metaIn[k] !== undefined) cleanMeta[k] = metaIn[k];
  }
  const normalized: Record<string, unknown> = {
    apiVersion: obj['apiVersion'] ?? apiVersionFallback,
    kind: obj['kind'] ?? kindFallback,
    metadata: cleanMeta,
  };
  if (obj['spec'] !== undefined) normalized['spec'] = obj['spec'];
  if (obj['data'] !== undefined) normalized['data'] = obj['data'];
  if (obj['stringData'] !== undefined) normalized['stringData'] = obj['stringData'];
  if (obj['type'] !== undefined && obj['kind'] === 'Secret') normalized['type'] = obj['type'];

  const parsed = k1cResourceSchema.safeParse(normalized);
  if (!parsed.success) return null;

  const finalizers = Array.isArray(metaIn['finalizers'])
    ? (metaIn['finalizers'] as ReadonlyArray<string>).filter((f) => typeof f === 'string')
    : [];
  const deletionTimestamp =
    typeof metaIn['deletionTimestamp'] === 'string'
      ? (metaIn['deletionTimestamp'] as string)
      : undefined;
  const status = (obj['status'] as Record<string, unknown> | undefined) ?? {};
  const nativeIdFromStatus =
    typeof status['cloudflareNativeId'] === 'string'
      ? (status['cloudflareNativeId'] as string)
      : undefined;

  return {
    resource: parsed.data as K1cResource,
    meta: {
      ...(crd ? { crd } : {}),
      ...(deletionTimestamp ? { deletionTimestamp } : {}),
      finalizers,
      ...(nativeIdFromStatus ? { nativeIdFromStatus } : {}),
    },
  };
}
