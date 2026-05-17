import * as k8s from '@kubernetes/client-node';
import Cloudflare from 'cloudflare';
import type { ProviderContext } from '../providers/types.ts';
import { createDefaultRegistry, type ProviderRegistry } from '../providers/index.ts';
import { lower } from '../manifest/lower.ts';
import { plan } from '../reconciler/plan.ts';
import { apply } from '../reconciler/apply.ts';
import { listManagedResources, MANAGED_LABEL, type ManagedResource } from './source.ts';
import { writeStatus } from './status.ts';
import { startWatches, type KindSpec } from './watch.ts';
import { incCounter, observeSummary, setGauge } from './metrics.ts';
import { startMetricsServer } from './server.ts';
import { runLeaderElection } from './leader.ts';
import { createLogger, type LogFormat } from './log.ts';
import { ensureFinalizer, K1C_FINALIZER, removeFinalizer } from './finalizer.ts';

export interface OperatorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly zoneId?: string;
  /** Restrict watching to a single namespace; default: cluster-wide. */
  readonly namespace?: string;
  /**
   * Resync interval in ms. With watches enabled this acts as a safety
   * net to catch any events the operator might have missed during a
   * reconnect; reconcile is primarily driven by watch events.
   */
  readonly intervalMs: number;
  /**
   * Use k8s watch streams to drive reconciles. Default true (Phase 2).
   * Pass false to fall back to pure polling at `intervalMs`.
   */
  readonly watch?: boolean;
  /** Debounce events by this many ms before triggering reconcile. */
  readonly debounceMs?: number;
  /**
   * Bind address for the metrics + health HTTP server. Default
   * `0.0.0.0:9090`. Pass empty string to disable.
   */
  readonly metricsAddr?: string;
  /**
   * Enable leader election via a `coordination.k8s.io/v1` Lease.
   * Default false. When true, only one operator replica reconciles at
   * a time; followers wait on the lease and take over within
   * `leaseDurationSec` of the leader's last renew.
   */
  readonly leaderElection?: boolean;
  /** Lease object name (default: `k1c-operator`). */
  readonly leaseName?: string;
  /** Lease namespace (default: `k1c-system`). */
  readonly leaseNamespace?: string;
  /** `text` (default) or `json` for structured log aggregators. */
  readonly logFormat?: LogFormat;
  /** Hook for log lines (default: console.log). Only used by tests. */
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
  /**
   * Swap the provider registry. Only used by tests to inject a
   * fake-provider registry so the reconcile loop can be driven against
   * a real apiserver (envtest) without hitting Cloudflare.
   */
  readonly registryOverride?: ProviderRegistry;
}

const CLOUDFLARE_GROUP = 'cloudflare.k1c.io';
const CLOUDFLARE_VERSION = 'v1alpha1';

/**
 * Plurals for every Cloudflare CRD kind we want to react to. Mirrors
 * `CLOUDFLARE_KINDS_BY_PLURAL` in source.ts but inverted; kept in sync
 * because watch + list both walk the same set of kinds.
 */
const CLOUDFLARE_PLURALS: ReadonlyArray<string> = [
  'r2buckets',
  'kvnamespaces',
  'd1databases',
  'hyperdrives',
  'queues',
  'vectorizes',
  'dnsrecords',
  'dispatchnamespaces',
  'logpushjobs',
  'telemetrystacks',
  'accessapplications',
  'accesspolicies',
  'cacherules',
  'transformrules',
  'urirewriterules',
  'responseheaderrules',
  'wafcustomrules',
  'wafmanagedrulesets',
  'ratelimitrules',
  'customhostnames',
  'emailroutingrules',
  'workercrontriggers',
  'r2bucketcorses',
  'r2bucketlifecycles',
  'r2bucketeventnotifications',
  'r2customdomains',
  'workerversions',
  'workerdeployments',
  'turnstilewidgets',
  'snippets',
  'streamkeys',
  'streamwatermarks',
];

/**
 * Standard kinds we observe with the `k1c.io/managed=true` label
 * gate. Same set source.ts queries.
 */
const STANDARD_KINDS: ReadonlyArray<KindSpec> = [
  { group: 'apps', version: 'v1', plural: 'deployments' },
  { group: 'apps', version: 'v1', plural: 'statefulsets' },
  { group: '', version: 'v1', plural: 'configmaps' },
  { group: '', version: 'v1', plural: 'secrets' },
  { group: '', version: 'v1', plural: 'services' },
  { group: 'batch', version: 'v1', plural: 'cronjobs' },
  { group: 'batch', version: 'v1', plural: 'jobs' },
  { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses' },
];

/**
 * Run the operator reconcile loop. Lists every k1c-managed resource (CRDs +
 * label-gated standard kinds), feeds them through the same lower / plan /
 * apply pipeline the CLI uses, and surfaces the result on the configured
 * output sinks. Returns when the AbortSignal aborts.
 */
export async function runOperator(options: OperatorOptions, signal: AbortSignal): Promise<void> {
  // The `out` / `err` callbacks remain available for tests that want
  // to capture every line regardless of format. In production both
  // are unset and the logger writes to stdout / stderr directly.
  const logger = createLogger({
    format: options.logFormat ?? 'text',
    ...(options.out ? { stdout: options.out } : {}),
    ...(options.err ? { stderr: options.err } : {}),
    defaults: {
      component: 'k1c-operator',
      ...(process.env['POD_NAME'] ? { pod: process.env['POD_NAME'] } : {}),
    },
  });
  const out = (m: string) => logger.info(m);
  const err = (m: string) => logger.error(m);

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const cloudflare = new Cloudflare({ apiToken: options.apiToken });
  const ctx: ProviderContext = {
    cloudflare,
    accountId: options.accountId,
    ...(options.zoneId !== undefined ? { zoneId: options.zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c-operator',
    signal,
  };
  const registry = options.registryOverride ?? createDefaultRegistry();

  const useWatch = options.watch ?? true;
  const debounceMs = options.debounceMs ?? 500;
  const metricsAddr = options.metricsAddr ?? '0.0.0.0:9090';

  out(
    `(k1c operator starting; account=${options.accountId}${options.namespace ? ` ns=${options.namespace}` : ' cluster-wide'} ${useWatch ? `watch+resync=${options.intervalMs}ms` : `interval=${options.intervalMs}ms`}${metricsAddr ? ` metrics=${metricsAddr}` : ''})`,
  );

  // Mark the process up; the gauge flips to 0 only at clean shutdown.
  setGauge('k1c_operator_up', '1 while the operator process is alive', 1);

  // `ready` flips to true once startup completes successfully — either
  // after the first reconcile pass (single-replica / no LE) or as soon
  // as the leader-election loop is active (HA mode, where a follower
  // is ready to take leadership but never reconciles itself). Without
  // the latter, follower pods never pass their `readinessProbe` and
  // the rollout stalls at 1/2.
  let ready = false;
  if (metricsAddr) {
    startMetricsServer({
      addr: metricsAddr,
      isReady: () => ready,
      signal,
      onWarning: (m) => err(`warning: ${m}`),
    });
  }

  // Run a first pass immediately so the operator does useful work without
  // waiting an entire interval; subsequent passes fire on the timer.
  let pending: Promise<void> | undefined;
  const tick = async () => {
    if (pending) return;
    pending = (async () => {
      const start = Date.now();
      try {
        const enriched = await listManagedResources({
          kc,
          ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
          onWarning: (m) => err(`warning: ${m}`),
        });
        setGauge(
          'k1c_operator_managed_resources',
          'count of managed resources observed in the last list pass',
          enriched.length,
        );

        // Phase A: process CRs that the user has asked to delete (k8s
        // sets `.metadata.deletionTimestamp` and our finalizer keeps
        // them alive in etcd until we acknowledge). For each one,
        // delete the Cloudflare resource via its persisted nativeId
        // (status.cloudflareNativeId), then strip our finalizer so
        // k8s can garbage-collect.
        const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        const deleting = enriched.filter(
          (e) => e.meta.deletionTimestamp && e.meta.finalizers.includes(K1C_FINALIZER),
        );
        for (const d of deleting) {
          if (!d.meta.crd) continue; // standard kinds don't get our finalizer
          const ns = d.resource.metadata.namespace ?? 'default';
          const name = d.resource.metadata.name;
          const nativeId = d.meta.nativeIdFromStatus;
          if (nativeId) {
            try {
              await registry.get(d.resource.kind).delete(ctx, nativeId);
              incCounter(
                'k1c_operator_finalizer_total',
                'finalizer cleanup outcomes',
                { outcome: 'deleted', kind: d.resource.kind },
              );
            } catch (e) {
              err(
                `finalizer: ${d.resource.kind}/${name} delete failed; leaving finalizer for retry: ${formatReconcileError(e)}`,
              );
              incCounter(
                'k1c_operator_finalizer_total',
                'finalizer cleanup outcomes',
                { outcome: 'delete_failed', kind: d.resource.kind },
              );
              continue;
            }
          } else {
            err(
              `finalizer: ${d.resource.kind}/${name} has no status.cloudflareNativeId; removing finalizer (orphan possible)`,
            );
            incCounter(
              'k1c_operator_finalizer_total',
              'finalizer cleanup outcomes',
              { outcome: 'orphan', kind: d.resource.kind },
            );
          }
          try {
            await removeFinalizer(
              customApi,
              {
                group: d.meta.crd.group,
                version: d.meta.crd.version,
                plural: d.meta.crd.plural,
                namespace: ns,
                name,
              },
              d.meta.finalizers,
            );
          } catch (e) {
            err(`finalizer: removeFinalizer ${d.resource.kind}/${name}: ${formatReconcileError(e)}`);
          }
        }

        // Phase B: alive CRs — make sure each Cloudflare CRD carries
        // our finalizer so the cascading delete in Phase A can run
        // when the user eventually `kubectl delete`s.
        const alive = enriched.filter((e) => !e.meta.deletionTimestamp);
        for (const a of alive) {
          if (!a.meta.crd) continue;
          if (a.meta.finalizers.includes(K1C_FINALIZER)) continue;
          try {
            await ensureFinalizer(
              customApi,
              {
                group: a.meta.crd.group,
                version: a.meta.crd.version,
                plural: a.meta.crd.plural,
                namespace: a.resource.metadata.namespace ?? 'default',
                name: a.resource.metadata.name,
              },
              a.meta.finalizers,
            );
            incCounter(
              'k1c_operator_finalizer_total',
              'finalizer cleanup outcomes',
              { outcome: 'attached', kind: a.resource.kind },
            );
          } catch (e) {
            err(
              `finalizer: ensureFinalizer ${a.resource.kind}/${a.resource.metadata.name}: ${formatReconcileError(e)}`,
            );
          }
        }

        const resources = alive.map((e) => e.resource);
        if (resources.length === 0) {
          out('reconcile: no managed resources found');
          incCounter(
            'k1c_operator_reconcile_passes_total',
            'reconcile pass outcomes',
            { outcome: 'noop' },
          );
          return;
        }
        const lowered = await lower(resources);
        const planResult = await plan(lowered.desired, registry, ctx);
        if (planResult.operations.every((o) => o.kind === 'noop')) {
          out(`reconcile: ${planResult.operations.length} ops (all noop)`);
          incCounter(
            'k1c_operator_reconcile_passes_total',
            'reconcile pass outcomes',
            { outcome: 'noop' },
          );
          return;
        }
        const report = await apply(planResult, registry, ctx);
        out(
          `reconcile: ${report.succeeded} ok / ${report.failed} failed / ${report.skipped} skipped`,
        );
        incCounter(
          'k1c_operator_reconcile_total',
          'per-op reconcile results',
          { result: 'ok' },
          report.succeeded,
        );
        incCounter(
          'k1c_operator_reconcile_total',
          'per-op reconcile results',
          { result: 'failed' },
          report.failed,
        );
        incCounter(
          'k1c_operator_reconcile_total',
          'per-op reconcile results',
          { result: 'skipped' },
          report.skipped,
        );
        incCounter(
          'k1c_operator_reconcile_passes_total',
          'reconcile pass outcomes',
          { outcome: report.failed > 0 ? 'partial' : 'ok' },
        );
        if (report.failed > 0) {
          for (const r of report.results) {
            if (r.status === 'failed') {
              err(`failed: ${r.op.resourceType} ${r.op.label}: ${r.error?.message}`);
            }
          }
        }
        // Patch .status.conditions on every Cloudflare CRD instance
        // touched this pass so `kubectl get r2bucket` reflects the
        // actual reconcile state. Best-effort: status writeback errors
        // never fail the reconcile loop.
        await writeStatus({
          kc,
          report,
          onWarning: (m) => err(`warning: ${m}`),
        });
      } catch (e) {
        err(`reconcile error: ${formatReconcileError(e)}`);
        incCounter(
          'k1c_operator_reconcile_passes_total',
          'reconcile pass outcomes',
          { outcome: 'error' },
        );
        incCounter(
          'k1c_operator_reconcile_total',
          'per-op reconcile results',
          { result: 'error' },
        );
      } finally {
        observeSummary(
          'k1c_operator_reconcile_duration_seconds',
          'wall-clock duration of each reconcile pass',
          (Date.now() - start) / 1000,
        );
        ready = true;
        pending = undefined;
      }
    })();
  };

  // Coalesce a burst of watch events into a single tick. Without this
  // every ADDED phase fired during the apiserver's initial replay would
  // trigger its own reconcile pass; with this they collapse to one.
  let debounceTimer: NodeJS.Timeout | undefined;
  const triggerSoon = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void tick();
    }, debounceMs);
  };

  // Reconcile loop body. Pulled into a closure so leader election can
  // start/stop it on leadership transitions while the metrics server +
  // banner remain owned by the outer process.
  const startReconcileLoop = async (innerSignal: AbortSignal): Promise<void> => {
    if (useWatch) {
      const labelSel = `${MANAGED_LABEL}=true`;
      const watchSpecs: KindSpec[] = [
        ...CLOUDFLARE_PLURALS.map((plural) => ({
          group: CLOUDFLARE_GROUP,
          version: CLOUDFLARE_VERSION,
          plural,
        })),
        ...STANDARD_KINDS.map((s) => ({ ...s, labelSelector: labelSel })),
      ];
      startWatches(kc, watchSpecs, {
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        signal: innerSignal,
        onEvent: (kind, phase) => {
          incCounter(
            'k1c_operator_watch_events_total',
            'watch events delivered by the apiserver',
            { kind: kind.plural, phase },
          );
          triggerSoon();
        },
        onWarning: (m) => err(`warning: ${m}`),
      });
    }

    await tick();
    while (!innerSignal.aborted) {
      // Resync interval doubles as the safety-net poll: even with
      // watches open, if the apiserver drops events during a reconnect
      // we'll catch up on the next tick.
      await sleep(options.intervalMs, innerSignal);
      if (innerSignal.aborted) break;
      await tick();
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    // Graceful drain: wait up to 30s for the in-flight tick (if any)
    // to settle before returning. Better to let an apply finish
    // posting to Cloudflare than to kill it mid-call. Hard cap so a
    // hung Cloudflare connection can't block shutdown indefinitely.
    if (pending) {
      out('(draining in-flight reconcile…)');
      const DRAIN_DEADLINE_MS = 30_000;
      let drainTimeout: NodeJS.Timeout | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          drainTimeout = setTimeout(() => {
            err('warning: in-flight reconcile did not finish within 30s; abandoning');
            resolve();
          }, DRAIN_DEADLINE_MS);
        }),
      ]);
      if (drainTimeout) clearTimeout(drainTimeout);
    }
  };

  if (options.leaderElection) {
    let inner: AbortController | undefined;
    const leaseName = options.leaseName ?? 'k1c-operator';
    const leaseNamespace = options.leaseNamespace ?? 'k1c-system';
    out(`(leader election enabled; lease=${leaseNamespace}/${leaseName})`);
    setGauge('k1c_operator_is_leader', '1 while this replica holds the leader lease', 0);
    // Followers never tick(), so flip `ready` here to true so their
    // readinessProbe passes. The leader will tick + flip it again
    // when its first reconcile lands; that's idempotent.
    ready = true;
    await runLeaderElection({
      kc,
      leaseName,
      leaseNamespace,
      signal,
      onAcquire: () => {
        out('(acquired leadership)');
        setGauge(
          'k1c_operator_is_leader',
          '1 while this replica holds the leader lease',
          1,
        );
        inner = new AbortController();
        // Mirror the outer abort to the inner controller so a graceful
        // shutdown also stops the active reconcile loop.
        signal.addEventListener('abort', () => inner?.abort(), { once: true });
        void startReconcileLoop(inner.signal);
      },
      onLose: () => {
        out('(lost leadership)');
        setGauge(
          'k1c_operator_is_leader',
          '1 while this replica holds the leader lease',
          0,
        );
        inner?.abort();
        inner = undefined;
      },
      onWarning: (m) => err(`warning: ${m}`),
    });
  } else {
    await startReconcileLoop(signal);
  }
  out('(operator stopped)');
}

/**
 * Same shape as the CLI's `formatError`: ProviderError instances are plain
 * objects so `String(err)` would produce `[object Object]`. Pull `code` and
 * `message` out by hand when the value looks structured.
 */
function formatReconcileError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.message === 'string') {
      return typeof e.code === 'string' ? `[${e.code}] ${e.message}` : e.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
