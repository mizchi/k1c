import * as k8s from '@kubernetes/client-node';
import type { ApplyReport, OperationResult } from '../reconciler/types.ts';
import { namespaceFromLabel } from '../reconciler/types.ts';

/**
 * Cloudflare CRD kinds that get .status.conditions writeback. Workload
 * kinds (Deployment / StatefulSet / ConfigMap / etc.) live under standard
 * k8s groups with their own status semantics; we don't touch those.
 */
const CLOUDFLARE_PLURAL_BY_KIND: Readonly<Record<string, string>> = {
  R2Bucket: 'r2buckets',
  KVNamespace: 'kvnamespaces',
  D1Database: 'd1databases',
  Hyperdrive: 'hyperdrives',
  Queue: 'queues',
  Vectorize: 'vectorizes',
  DNSRecord: 'dnsrecords',
  DispatchNamespace: 'dispatchnamespaces',
  LogpushJob: 'logpushjobs',
  TelemetryStack: 'telemetrystacks',
  AccessApplication: 'accessapplications',
  AccessPolicy: 'accesspolicies',
  CacheRule: 'cacherules',
  TransformRule: 'transformrules',
  URIRewriteRule: 'urirewriterules',
  ResponseHeaderRule: 'responseheaderrules',
  WAFCustomRule: 'wafcustomrules',
  WAFManagedRuleset: 'wafmanagedrulesets',
  RateLimitRule: 'ratelimitrules',
  CustomHostname: 'customhostnames',
  EmailRoutingRule: 'emailroutingrules',
  WorkerCronTrigger: 'workercrontriggers',
  R2BucketCors: 'r2bucketcorses',
  R2BucketLifecycle: 'r2bucketlifecycles',
  R2BucketEventNotification: 'r2bucketeventnotifications',
  R2CustomDomain: 'r2customdomains',
  WorkerVersion: 'workerversions',
  WorkerDeployment: 'workerdeployments',
  TurnstileWidget: 'turnstilewidgets',
  Snippet: 'snippets',
  StreamKey: 'streamkeys',
  StreamWatermark: 'streamwatermarks',
  Zone: 'zones',
  ZoneSetting: 'zonesettings',
  LoadBalancerMonitor: 'loadbalancermonitors',
  LoadBalancerPool: 'loadbalancerpools',
  LoadBalancer: 'loadbalancers',
  NotificationPolicy: 'notificationpolicies',
  CertificatePack: 'certificatepacks',
  WebAnalyticsSite: 'webanalyticssites',
};

const CLOUDFLARE_GROUP = 'cloudflare.k1c.io';
const CLOUDFLARE_VERSION = 'v1alpha1';

interface PerInstance {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  succeeded: number;
  failed: number;
  skipped: number;
  noop: number;
  firstError?: string;
  /**
   * Cloudflare native id from the most recent successful create or
   * update result for this CR. Persisted into `.status.cloudflareNativeId`
   * so the finalizer cleanup path knows which Cloudflare resource to
   * delete after `kubectl delete` strips the spec from etcd.
   */
  nativeId?: string;
}

export interface WriteStatusOptions {
  readonly kc: k8s.KubeConfig;
  readonly report: ApplyReport;
  readonly onWarning?: (msg: string) => void;
}

/**
 * Patch `.status.conditions` on every Cloudflare CRD instance touched by
 * the apply pass. One condition per instance:
 *
 *   type: Ready
 *   status: True | False
 *   reason: Reconciled | ReconcileFailed
 *   message: <succeeded ok / failed n / skipped n>
 *
 * Plus `observedGeneration` / `lastTransitionTime` for the standard
 * Kubernetes condition shape. Status writes go to the /status
 * subresource so they don't bump `metadata.generation`, which would
 * otherwise feed back into the reconcile loop.
 */
export async function writeStatus(options: WriteStatusOptions): Promise<void> {
  const onWarning = options.onWarning ?? ((m) => console.warn(m));
  const customApi = options.kc.makeApiClient(k8s.CustomObjectsApi);

  // Bucket per-op results into per-instance summaries (one CRD instance
  // can fan out to multiple Cloudflare ops, especially once telemetry /
  // ruleset / aggregator manifests are involved).
  const byInstance = new Map<string, PerInstance>();
  for (const r of options.report.results) {
    const kind = r.op.resourceType;
    if (!(kind in CLOUDFLARE_PLURAL_BY_KIND)) continue;
    const label = (r.op as { label?: string }).label;
    if (label === undefined) continue;
    const namespace = namespaceFromLabel(label);
    const name = label.includes('/') ? label.slice(label.indexOf('/') + 1) : label;
    const key = `${kind}\0${namespace}\0${name}`;
    let agg = byInstance.get(key);
    if (!agg) {
      agg = { kind, namespace, name, succeeded: 0, failed: 0, skipped: 0, noop: 0 };
      byInstance.set(key, agg);
    }
    if (r.status === 'succeeded' && r.op.kind === 'noop') agg.noop += 1;
    else if (r.status === 'succeeded') agg.succeeded += 1;
    else if (r.status === 'failed') {
      agg.failed += 1;
      if (!agg.firstError) agg.firstError = r.error?.message ?? 'unknown error';
    } else agg.skipped += 1;
    // Persist the Cloudflare native id from the most recent successful
    // op so the finalizer cleanup path can delete the resource even
    // after the CR's spec is gone from etcd.
    if (r.status === 'succeeded' && r.nativeId) agg.nativeId = r.nativeId;
  }

  for (const inst of byInstance.values()) {
    await patchOne(customApi, inst, onWarning);
  }
}

async function patchOne(
  customApi: k8s.CustomObjectsApi,
  inst: PerInstance,
  onWarning: (m: string) => void,
): Promise<void> {
  const plural = CLOUDFLARE_PLURAL_BY_KIND[inst.kind];
  if (!plural) return;
  const ready = inst.failed === 0;
  const message = `${inst.succeeded} ok / ${inst.failed} failed / ${inst.skipped} skipped${inst.noop > 0 ? ` / ${inst.noop} noop` : ''}${inst.firstError ? `: ${inst.firstError}` : ''}`;

  const patch = {
    status: {
      conditions: [
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          reason: ready ? 'Reconciled' : 'ReconcileFailed',
          message,
          lastTransitionTime: new Date().toISOString(),
        },
      ],
      // Surface the Cloudflare native id so the finalizer cleanup path
      // (operator/reconcile.ts) can call provider.delete after the CR's
      // spec is gone. Only stamped when we actually got a fresh id from
      // a successful op this pass.
      ...(inst.nativeId ? { cloudflareNativeId: inst.nativeId } : {}),
    },
  };

  try {
    await customApi.patchNamespacedCustomObjectStatus(
      {
        group: CLOUDFLARE_GROUP,
        version: CLOUDFLARE_VERSION,
        namespace: inst.namespace,
        plural,
        name: inst.name,
        body: patch,
      },
      // application/merge-patch+json — replaces conditions wholesale.
      // We could switch to a strategic merge later if we want
      // multi-condition append semantics.
      k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
    );
  } catch (e) {
    const code = (e as { code?: number }).code;
    // 404 means the user deleted the CRD instance between list and
    // patch; that is a valid race, not a bug. 405 means the cluster's
    // CRD definition doesn't have the /status subresource enabled
    // (older cluster from before we added it to export-crds); skip
    // silently rather than spam the operator log every reconcile.
    if (code === 404 || code === 405) return;
    onWarning(
      `status writeback failed for ${inst.kind} ${inst.namespace}/${inst.name}: ${(e as Error).message ?? e}`,
    );
  }
}
