import type { K1cResource, Rollout } from '../manifest/types.ts';
import type { DesiredResource } from '../reconciler/types.ts';
import type { ProviderContext } from '../providers/types.ts';
import type { WorkerProperties } from '../providers/worker.ts';
import {
  runCanaryAdvance,
  type CanaryEffects,
  type RolloutAdvanceInput,
  type RolloutStateClient,
} from '../canary/runtime.ts';
import { buildCloudflareEffects } from '../canary/effects-cloudflare.ts';

const CANARY_ANNOTATION = 'cloudflare.com/dispatch-namespace';

export interface CanaryIntegrationDeps {
  readonly providerCtx: ProviderContext;
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
  readonly now: () => Date;
}

export async function advanceCanaryRolloutsForApply(
  parsed: ReadonlyArray<K1cResource>,
  desired: ReadonlyArray<DesiredResource>,
  deps: CanaryIntegrationDeps,
): Promise<void> {
  const annotatedRollouts = parsed.filter(
    (r): r is Rollout =>
      r.kind === 'Rollout' &&
      typeof r.metadata.annotations?.[CANARY_ANNOTATION] === 'string',
  );
  if (annotatedRollouts.length === 0) return;

  const inputs = await Promise.all(
    annotatedRollouts.map((rollout) => buildInputForRollout(rollout, desired, deps)),
  );
  const valid = inputs.filter((i): i is RolloutAdvanceInput => i !== null);
  if (valid.length === 0) return;

  const stateClient = await buildStateClient(annotatedRollouts, deps);
  if (stateClient === null) {
    deps.err(
      `canary advance skipped: rollout-state KV not yet provisioned (re-run \`k1c apply\` after the standard apply finishes)`,
    );
    return;
  }
  const effects = buildCloudflareEffects({
    cloudflare: deps.providerCtx.cloudflare,
    accountId: deps.providerCtx.accountId,
    managedByLabel: deps.providerCtx.managedByLabel,
  });

  deps.out('');
  deps.out('[canary]');
  const reports = await runCanaryAdvance(valid, {
    state: stateClient,
    effects,
    now: deps.now,
  });
  for (const r of reports) {
    deps.out(
      `  ${r.label}: ${r.previousStatus} → ${r.nextStatus} (weight=${r.nextWeight}%)` +
        (r.actions.length ? `, actions: ${r.actions.map((a) => a.kind).join(', ')}` : ''),
    );
  }
}

async function buildInputForRollout(
  rollout: Rollout,
  desired: ReadonlyArray<DesiredResource>,
  deps: CanaryIntegrationDeps,
): Promise<RolloutAdvanceInput | null> {
  const ns = rollout.metadata.namespace ?? 'default';
  const name = rollout.metadata.name;
  const stableLabel = `${ns}/${name}--stable`;
  const stable = desired.find(
    (d) => d.resourceType === 'Worker' && d.label === stableLabel,
  );
  if (!stable) {
    deps.err(`canary: stable DesiredResource for ${ns}/${name} not found in lowered output`);
    return null;
  }
  const stableProps = stable.properties as WorkerProperties;
  const entrypointContent = await readEntrypoint(stableProps, deps);
  return { rollout, stableProps, entrypointContent };
}

async function readEntrypoint(
  props: WorkerProperties,
  deps: CanaryIntegrationDeps,
): Promise<Uint8Array> {
  if (props.entrypointContent !== undefined) {
    return new TextEncoder().encode(props.entrypointContent);
  }
  const reader =
    deps.providerCtx.readFile ??
    (async (p: string) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(p);
    });
  return reader(props.entrypoint);
}

async function buildStateClient(
  rollouts: ReadonlyArray<Rollout>,
  deps: CanaryIntegrationDeps,
): Promise<RolloutStateClient | null> {
  // For v0.1.2, we assume a single dispatch namespace per apply (the common case).
  const dispatch = rollouts[0]?.metadata.annotations?.[CANARY_ANNOTATION];
  if (dispatch === undefined) return null;
  const expected = `k1c/rollout-state/${dispatch}`;
  let stateKvId: string | null = null;
  for await (const ns of deps.providerCtx.cloudflare.kv.namespaces.list({
    account_id: deps.providerCtx.accountId,
  })) {
    if (ns.title === expected) {
      stateKvId = ns.id;
      break;
    }
  }
  if (stateKvId === null) return null;
  const accountId = deps.providerCtx.accountId;
  const cf = deps.providerCtx.cloudflare;
  return {
    async read(key: string): Promise<string | null> {
      try {
        const resp = await cf.kv.namespaces.values.get(stateKvId, key, {
          account_id: accountId,
        });
        return await resp.text();
      } catch (e) {
        if (e !== null && typeof e === 'object' && (e as { status?: number }).status === 404) {
          return null;
        }
        throw e;
      }
    },
    async write(key: string, value: string): Promise<void> {
      await cf.kv.namespaces.values.update(stateKvId, key, {
        account_id: accountId,
        value,
      });
    },
  };
}
