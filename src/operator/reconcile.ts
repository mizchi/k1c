import * as k8s from '@kubernetes/client-node';
import Cloudflare from 'cloudflare';
import type { ProviderContext } from '../providers/types.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import { lower } from '../manifest/lower.ts';
import { plan } from '../reconciler/plan.ts';
import { apply } from '../reconciler/apply.ts';
import { listManagedResources, MANAGED_LABEL } from './source.ts';
import { writeStatus } from './status.ts';
import { startWatches, type KindSpec } from './watch.ts';

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
  /** Hook for log lines (default: console.log). */
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
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
  const out = options.out ?? ((m) => console.log(m));
  const err = options.err ?? ((m) => console.error(m));

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
  const registry = createDefaultRegistry();

  const useWatch = options.watch ?? true;
  const debounceMs = options.debounceMs ?? 500;

  out(
    `(k1c operator starting; account=${options.accountId}${options.namespace ? ` ns=${options.namespace}` : ' cluster-wide'} ${useWatch ? `watch+resync=${options.intervalMs}ms` : `interval=${options.intervalMs}ms`})`,
  );

  // Run a first pass immediately so the operator does useful work without
  // waiting an entire interval; subsequent passes fire on the timer.
  let pending: Promise<void> | undefined;
  const tick = async () => {
    if (pending) return;
    pending = (async () => {
      try {
        const resources = await listManagedResources({
          kc,
          ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
          onWarning: (m) => err(`warning: ${m}`),
        });
        if (resources.length === 0) {
          out('reconcile: no managed resources found');
          return;
        }
        const lowered = await lower(resources);
        const planResult = await plan(lowered.desired, registry, ctx);
        if (planResult.operations.every((o) => o.kind === 'noop')) {
          out(`reconcile: ${planResult.operations.length} ops (all noop)`);
          return;
        }
        const report = await apply(planResult, registry, ctx);
        out(
          `reconcile: ${report.succeeded} ok / ${report.failed} failed / ${report.skipped} skipped`,
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
      } finally {
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
      signal,
      onEvent: (_kind, _phase) => triggerSoon(),
      onWarning: (m) => err(`warning: ${m}`),
    });
  }

  await tick();
  while (!signal.aborted) {
    // Resync interval doubles as the safety-net poll: even with watches
    // open, if the apiserver drops events during a reconnect we'll
    // catch up on the next tick.
    await sleep(options.intervalMs, signal);
    if (signal.aborted) break;
    await tick();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
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
