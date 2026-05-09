import * as k8s from '@kubernetes/client-node';
import Cloudflare from 'cloudflare';
import type { ProviderContext } from '../providers/types.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import { lower } from '../manifest/lower.ts';
import { plan } from '../reconciler/plan.ts';
import { apply } from '../reconciler/apply.ts';
import { listManagedResources } from './source.ts';

export interface OperatorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly zoneId?: string;
  /** Restrict watching to a single namespace; default: cluster-wide. */
  readonly namespace?: string;
  /** How often to re-list and reconcile. Polling interval in ms. */
  readonly intervalMs: number;
  /** Hook for log lines (default: console.log). */
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
}

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

  out(
    `(k1c operator starting; account=${options.accountId}${options.namespace ? ` ns=${options.namespace}` : ' cluster-wide'} interval=${options.intervalMs}ms)`,
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
      } catch (e) {
        err(`reconcile error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        pending = undefined;
      }
    })();
  };

  await tick();
  while (!signal.aborted) {
    await sleep(options.intervalMs, signal);
    if (signal.aborted) break;
    await tick();
  }
  out('(operator stopped)');
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
