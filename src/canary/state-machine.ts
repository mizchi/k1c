/**
 * Pure state-machine for canary rollouts. Given the current KV-stored RolloutState,
 * the desired content hash, the rollout's `canary.steps[]`, and the current time,
 * compute the next RolloutState and the side-effects to execute.
 *
 * No I/O. All state is in inputs and outputs. Wiring (KV reads, API calls) lives
 * in the apply layer.
 */

export interface RolloutState {
  readonly status: 'idle' | 'progressing' | 'paused';
  readonly currentStepIndex: number;
  /** ISO8601 timestamp when the current canary started, or null when idle. */
  readonly startedAt: string | null;
  /** ISO8601 timestamp when the last setWeight took effect, or null when idle. */
  readonly lastAdvanceAt: string | null;
  /** Script name of the stable variant (e.g. `k1c--default--api--stable`). */
  readonly stableScript: string;
  /** Script name of the canary variant, or null when no canary in flight. */
  readonly canaryScript: string | null;
  /** 0-100, percentage routed to canary. 0 when idle / paused at step 0. */
  readonly weight: number;
  /** Hash of the deployed stable content. */
  readonly stableHash: string;
  /** Hash of the canary content currently being rolled out, or null when idle. */
  readonly canaryHash: string | null;
}

export type CanaryStep =
  | { readonly setWeight: number }
  | { readonly pause: { readonly duration?: string } };

export interface AdvanceInput {
  /** Current state from KV; null on first apply. */
  readonly state: RolloutState | null;
  /** Hash of the desired stable content the user wants live. */
  readonly desiredHash: string;
  /** The Rollout's strategy.canary.steps[]. */
  readonly steps: ReadonlyArray<CanaryStep>;
  /** Stable script name (k1c naming convention, deterministic). */
  readonly stableScriptName: string;
  /** Canary script name. */
  readonly canaryScriptName: string;
  /** Current time. */
  readonly now: Date;
}

export type Action =
  | { readonly kind: 'init-stable'; readonly hash: string }
  | { readonly kind: 'upload-canary'; readonly hash: string }
  | { readonly kind: 'set-weight'; readonly weight: number }
  | { readonly kind: 'promote-canary'; readonly hash: string }
  | { readonly kind: 'remove-canary' }
  | { readonly kind: 'wait'; readonly reason: 'duration-not-elapsed' | 'manual-promote-needed' };

export interface AdvanceOutput {
  readonly nextState: RolloutState;
  readonly actions: ReadonlyArray<Action>;
}

export function advance(input: AdvanceInput): AdvanceOutput {
  const { state, desiredHash, steps, stableScriptName, canaryScriptName, now } = input;

  // First apply: no prior state. Upload as stable, mark idle.
  if (state === null) {
    return {
      nextState: {
        status: 'idle',
        currentStepIndex: 0,
        startedAt: null,
        lastAdvanceAt: null,
        stableScript: stableScriptName,
        canaryScript: null,
        weight: 0,
        stableHash: desiredHash,
        canaryHash: null,
      },
      actions: [{ kind: 'init-stable', hash: desiredHash }],
    };
  }

  // Workload changed mid-canary: restart the canary with the new content.
  if (state.canaryHash !== null && state.canaryHash !== desiredHash) {
    return startCanary(state, desiredHash, canaryScriptName, steps, now);
  }

  // No active canary, but desired matches stable: nothing to do.
  if (state.status === 'idle' && state.stableHash === desiredHash) {
    return { nextState: state, actions: [] };
  }

  // No active canary, desired differs from stable: start a new canary.
  if (state.status === 'idle' && state.stableHash !== desiredHash) {
    return startCanary(state, desiredHash, canaryScriptName, steps, now);
  }

  // Canary in progress (status === 'progressing' or 'paused'). Try to advance.
  return advanceStep(state, steps, now, canaryScriptName);
}

function startCanary(
  state: RolloutState,
  desiredHash: string,
  canaryScriptName: string,
  steps: ReadonlyArray<CanaryStep>,
  now: Date,
): AdvanceOutput {
  if (steps.length === 0) {
    // Edge case: empty steps → immediate cutover (treat as 100%).
    return {
      nextState: {
        ...state,
        stableHash: desiredHash,
        canaryScript: null,
        canaryHash: null,
        weight: 0,
        status: 'idle',
        currentStepIndex: 0,
      },
      actions: [{ kind: 'upload-canary', hash: desiredHash }, { kind: 'promote-canary', hash: desiredHash }],
    };
  }
  const firstStep = steps[0]!;
  const initialWeight = 'setWeight' in firstStep ? firstStep.setWeight : 0;
  const actions: Action[] = [
    { kind: 'upload-canary', hash: desiredHash },
    { kind: 'set-weight', weight: initialWeight },
  ];
  return {
    nextState: {
      ...state,
      canaryScript: canaryScriptName,
      canaryHash: desiredHash,
      weight: initialWeight,
      status: 'progressing',
      currentStepIndex: 'setWeight' in firstStep ? 1 : 0,
      startedAt: now.toISOString(),
      lastAdvanceAt: now.toISOString(),
    },
    actions,
  };
}

function advanceStep(
  state: RolloutState,
  steps: ReadonlyArray<CanaryStep>,
  now: Date,
  canaryScriptName: string,
): AdvanceOutput {
  const idx = state.currentStepIndex;

  // Finished all steps without an explicit setWeight 100 → promote.
  if (idx >= steps.length) {
    return promote(state);
  }

  const step = steps[idx]!;

  if ('setWeight' in step) {
    const w = step.setWeight;
    const advanced: RolloutState = {
      ...state,
      weight: w,
      currentStepIndex: idx + 1,
      lastAdvanceAt: now.toISOString(),
      status: 'progressing',
    };
    if (w >= 100) {
      return promote(advanced);
    }
    return {
      nextState: advanced,
      actions: [{ kind: 'set-weight', weight: w }],
    };
  }

  // pause step
  const duration = step.pause.duration;
  if (duration === undefined) {
    return {
      nextState: { ...state, status: 'paused' },
      actions: [{ kind: 'wait', reason: 'manual-promote-needed' }],
    };
  }
  const elapsedMs = now.getTime() - new Date(state.lastAdvanceAt ?? state.startedAt ?? now).getTime();
  if (elapsedMs >= parseDurationMs(duration)) {
    // Pause complete, advance past it and recurse to consume the next step.
    return advanceStep(
      { ...state, currentStepIndex: idx + 1, lastAdvanceAt: now.toISOString() },
      steps,
      now,
      canaryScriptName,
    );
  }
  return {
    nextState: state,
    actions: [{ kind: 'wait', reason: 'duration-not-elapsed' }],
  };
}

function promote(state: RolloutState): AdvanceOutput {
  if (state.canaryHash === null) {
    return { nextState: state, actions: [] };
  }
  return {
    nextState: {
      ...state,
      stableHash: state.canaryHash,
      canaryScript: null,
      canaryHash: null,
      weight: 0,
      status: 'idle',
      currentStepIndex: 0,
    },
    actions: [{ kind: 'promote-canary', hash: state.canaryHash }, { kind: 'remove-canary' }],
  };
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

export function parseDurationMs(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new Error(`invalid duration: ${input}`);
  }
  const n = Number(match[1]!);
  const unit = match[2]!;
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration unit: ${unit}`);
  }
}
