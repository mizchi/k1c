import type { RolloutStateClient } from './runtime.ts';
import type { RolloutState } from './state-machine.ts';

export type RolloutSubCommand = 'status' | 'promote' | 'abort';

export interface RolloutCommandInput {
  readonly subCommand: RolloutSubCommand;
  readonly target: string; // '<ns>/<name>'
}

export interface RolloutCommandDeps {
  readonly state: RolloutStateClient;
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

export async function runRolloutCommand(
  input: RolloutCommandInput,
  deps: RolloutCommandDeps,
): Promise<number> {
  const parts = input.target.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    deps.err(`invalid target "${input.target}"; expected <namespace>/<name>`);
    return 2;
  }
  const key = `rollout/${parts[0]}/${parts[1]}`;

  switch (input.subCommand) {
    case 'status':
      return runStatus(key, deps);
    case 'promote':
      return runPromote(key, deps);
    case 'abort':
      return runAbort(key, deps);
  }
}

async function runStatus(key: string, deps: RolloutCommandDeps): Promise<number> {
  const state = await readState(key, deps);
  if (state === null) {
    deps.out(`(no rollout state for ${key})`);
    return 0;
  }
  deps.out(formatStatus(state));
  return 0;
}

async function runPromote(key: string, deps: RolloutCommandDeps): Promise<number> {
  const state = await readState(key, deps);
  if (state === null) {
    deps.err(`no rollout state for ${key}; nothing to promote`);
    return 1;
  }
  if (state.status !== 'paused') {
    deps.err(`rollout ${key} is in status="${state.status}"; promote only applies to "paused"`);
    return 1;
  }
  const next: RolloutState = {
    ...state,
    currentStepIndex: state.currentStepIndex + 1,
    // Force the next apply to treat any pending duration as elapsed.
    lastAdvanceAt: new Date(0).toISOString(),
    status: 'progressing',
  };
  await deps.state.write(key, JSON.stringify(next));
  deps.out(`rollout ${key}: unpaused; the next \`k1c apply\` will advance to step ${next.currentStepIndex}`);
  return 0;
}

async function runAbort(key: string, deps: RolloutCommandDeps): Promise<number> {
  const state = await readState(key, deps);
  if (state === null) {
    deps.err(`no rollout state for ${key}; nothing to abort`);
    return 1;
  }
  const next: RolloutState = {
    ...state,
    canaryScript: null,
    canaryHash: null,
    weight: 0,
    status: 'idle',
    currentStepIndex: 0,
  };
  await deps.state.write(key, JSON.stringify(next));
  deps.out(`rollout ${key}: aborted; dispatcher routes 100% to stable`);
  deps.out('(canary script remains in dispatch namespace; the next `k1c apply` will not redeploy it)');
  return 0;
}

async function readState(
  key: string,
  deps: RolloutCommandDeps,
): Promise<RolloutState | null> {
  const raw = await deps.state.read(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RolloutState;
  } catch {
    deps.err(`rollout state at ${key} is not valid JSON`);
    return null;
  }
}

export function formatStatus(state: RolloutState): string {
  const lines = [
    `status:           ${state.status}`,
    `currentStepIndex: ${state.currentStepIndex}`,
    `weight:           ${state.weight}%`,
    `stableScript:     ${state.stableScript}`,
    `canaryScript:     ${state.canaryScript ?? '(none)'}`,
    `stableHash:       ${state.stableHash}`,
    `canaryHash:       ${state.canaryHash ?? '(none)'}`,
    `startedAt:        ${state.startedAt ?? '(never)'}`,
    `lastAdvanceAt:    ${state.lastAdvanceAt ?? '(never)'}`,
  ];
  return lines.join('\n');
}
