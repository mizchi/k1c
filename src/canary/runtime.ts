import { createHash } from 'node:crypto';
import type { Rollout, ResourceRef } from '../manifest/types.ts';
import type { WorkerProperties } from '../providers/worker.ts';
import {
  advance,
  type Action,
  type CanaryStep,
  type RolloutState,
} from './state-machine.ts';

/**
 * Reads/writes the JSON state document for a single rollout. Production wires this to
 * `cloudflare.kv.namespaces.values.{get, update}`; tests pass an in-memory implementation.
 */
export interface RolloutStateClient {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/**
 * Side-effect hooks for the actions returned by the state machine. Implementations
 * upload/remove canary scripts via the dispatch-namespace endpoint.
 */
export interface CanaryEffects {
  uploadCanary(input: {
    rolloutRef: ResourceRef;
    scriptName: string;
    dispatchNamespace: string;
    content: Uint8Array;
    properties: WorkerProperties;
  }): Promise<void>;
  promoteCanaryToStable(input: {
    rolloutRef: ResourceRef;
    stableScriptName: string;
    canaryScriptName: string;
    dispatchNamespace: string;
    content: Uint8Array;
    properties: WorkerProperties;
  }): Promise<void>;
  removeCanary(input: {
    rolloutRef: ResourceRef;
    scriptName: string;
    dispatchNamespace: string;
  }): Promise<void>;
}

export interface RolloutAdvanceInput {
  readonly rollout: Rollout;
  /** WorkerProperties of the user's stable Worker (resolved by lower). */
  readonly stableProps: WorkerProperties;
  /** Entrypoint bytes (already read from disk by caller). */
  readonly entrypointContent: Uint8Array;
}

export interface RolloutAdvanceReport {
  readonly label: string;
  readonly previousStatus: string;
  readonly nextStatus: string;
  readonly nextWeight: number;
  readonly actions: ReadonlyArray<Action>;
}

export interface RuntimeDeps {
  readonly state: RolloutStateClient;
  readonly effects: CanaryEffects;
  readonly now: () => Date;
}

export async function runCanaryAdvance(
  inputs: ReadonlyArray<RolloutAdvanceInput>,
  deps: RuntimeDeps,
): Promise<ReadonlyArray<RolloutAdvanceReport>> {
  const reports: RolloutAdvanceReport[] = [];
  for (const input of inputs) {
    reports.push(await processRollout(input, deps));
  }
  return reports;
}

async function processRollout(
  input: RolloutAdvanceInput,
  deps: RuntimeDeps,
): Promise<RolloutAdvanceReport> {
  const ns = input.rollout.metadata.namespace ?? 'default';
  const name = input.rollout.metadata.name;
  const label = `${ns}/${name}`;
  const stateKey = `rollout/${ns}/${name}`;
  const stableScriptName = `k1c--${ns}--${name}--stable`;
  const canaryScriptName = `k1c--${ns}--${name}--canary`;
  const desiredHash = bundleHash(input.stableProps, input.entrypointContent);
  const steps = extractCanarySteps(input.rollout);

  const previous = await loadState(deps, stateKey);
  const out = advance({
    state: previous,
    desiredHash,
    steps,
    stableScriptName,
    canaryScriptName,
    now: deps.now(),
  });

  await executeActions(input, out.actions, deps, {
    canaryScriptName,
    stableScriptName,
  });
  await deps.state.write(stateKey, JSON.stringify(out.nextState));

  return {
    label,
    previousStatus: previous?.status ?? 'absent',
    nextStatus: out.nextState.status,
    nextWeight: out.nextState.weight,
    actions: out.actions,
  };
}

async function loadState(
  deps: RuntimeDeps,
  key: string,
): Promise<RolloutState | null> {
  const raw = await deps.state.read(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RolloutState;
  } catch {
    return null;
  }
}

async function executeActions(
  input: RolloutAdvanceInput,
  actions: ReadonlyArray<Action>,
  deps: RuntimeDeps,
  names: { canaryScriptName: string; stableScriptName: string },
): Promise<void> {
  const dispatchNs = input.stableProps.dispatchNamespace;
  if (dispatchNs === undefined) {
    throw new Error(
      `Rollout ${input.rollout.metadata.name}: stable WorkerProperties is missing dispatchNamespace; canary runtime requires it`,
    );
  }
  const ref: ResourceRef = {
    apiVersion: input.rollout.apiVersion,
    kind: input.rollout.kind,
    namespace: input.rollout.metadata.namespace ?? 'default',
    name: input.rollout.metadata.name,
  };
  const canaryProps: WorkerProperties = {
    ...input.stableProps,
    scriptName: names.canaryScriptName,
  };

  for (const action of actions) {
    switch (action.kind) {
      case 'init-stable':
      case 'wait':
      case 'set-weight':
        // No script-side work: stable is uploaded by the standard apply path,
        // and `set-weight` is realised by the dispatcher reading our updated state JSON.
        break;
      case 'upload-canary':
        await deps.effects.uploadCanary({
          rolloutRef: ref,
          scriptName: names.canaryScriptName,
          dispatchNamespace: dispatchNs,
          content: input.entrypointContent,
          properties: canaryProps,
        });
        break;
      case 'promote-canary':
        await deps.effects.promoteCanaryToStable({
          rolloutRef: ref,
          stableScriptName: names.stableScriptName,
          canaryScriptName: names.canaryScriptName,
          dispatchNamespace: dispatchNs,
          content: input.entrypointContent,
          properties: { ...input.stableProps, scriptName: names.stableScriptName },
        });
        break;
      case 'remove-canary':
        await deps.effects.removeCanary({
          rolloutRef: ref,
          scriptName: names.canaryScriptName,
          dispatchNamespace: dispatchNs,
        });
        break;
    }
  }
}

function extractCanarySteps(rollout: Rollout): ReadonlyArray<CanaryStep> {
  if ('canary' in rollout.spec.strategy) {
    return rollout.spec.strategy.canary.steps;
  }
  // blueGreen → equivalent to single 100% step (immediate cutover)
  return [{ setWeight: 100 }];
}

export function bundleHash(
  props: WorkerProperties,
  entrypointContent: Uint8Array,
): string {
  const h = createHash('sha256');
  h.update(entrypointContent);
  const bindingsKey = canonicalize({
    vars: props.vars ?? {},
    secrets: props.secrets ?? {},
    bindings: props.bindings ?? [],
    compatibilityDate: props.compatibilityDate,
    compatibilityFlags: props.compatibilityFlags ?? [],
    observability: props.observability,
    placement: props.placement,
  });
  h.update(bindingsKey);
  return h.digest('hex');
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
