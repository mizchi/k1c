import { describe, it, expect } from 'vitest';
import {
  advance,
  parseDurationMs,
  type AdvanceInput,
  type RolloutState,
} from './state-machine.ts';

const NAMES = {
  stableScriptName: 'k1c--default--api--stable',
  canaryScriptName: 'k1c--default--api--canary',
};

const baseInput = (overrides: Partial<AdvanceInput>): AdvanceInput => ({
  state: null,
  desiredHash: 'hash-v1',
  steps: [{ setWeight: 100 }],
  ...NAMES,
  now: new Date('2026-05-08T12:00:00Z'),
  ...overrides,
});

const idleStable = (hash = 'hash-v1'): RolloutState => ({
  status: 'idle',
  currentStepIndex: 0,
  startedAt: null,
  lastAdvanceAt: null,
  stableScript: NAMES.stableScriptName,
  canaryScript: null,
  weight: 0,
  stableHash: hash,
  canaryHash: null,
});

describe('advance', () => {
  it('first apply (state=null): emits init-stable and stores hash as stable', () => {
    const out = advance(baseInput({}));
    expect(out.actions).toEqual([{ kind: 'init-stable', hash: 'hash-v1' }]);
    expect(out.nextState.status).toBe('idle');
    expect(out.nextState.stableHash).toBe('hash-v1');
    expect(out.nextState.canaryScript).toBeNull();
  });

  it('idle + same hash: no actions', () => {
    const out = advance(baseInput({ state: idleStable('hash-v1') }));
    expect(out.actions).toEqual([]);
    expect(out.nextState).toEqual(idleStable('hash-v1'));
  });

  it('idle + new hash: starts a canary, uploads + applies first setWeight', () => {
    const out = advance(
      baseInput({
        state: idleStable('hash-v1'),
        desiredHash: 'hash-v2',
        steps: [{ setWeight: 10 }, { pause: { duration: '5m' } }, { setWeight: 100 }],
      }),
    );
    expect(out.actions).toEqual([
      { kind: 'upload-canary', hash: 'hash-v2' },
      { kind: 'set-weight', weight: 10 },
    ]);
    expect(out.nextState.status).toBe('progressing');
    expect(out.nextState.canaryHash).toBe('hash-v2');
    expect(out.nextState.weight).toBe(10);
    expect(out.nextState.currentStepIndex).toBe(1);
  });

  it('progressing + pause not elapsed: emits wait, state unchanged', () => {
    const earlier = new Date('2026-05-08T12:00:00Z');
    const state: RolloutState = {
      status: 'progressing',
      currentStepIndex: 1,
      startedAt: earlier.toISOString(),
      lastAdvanceAt: earlier.toISOString(),
      stableScript: NAMES.stableScriptName,
      canaryScript: NAMES.canaryScriptName,
      weight: 10,
      stableHash: 'hash-v1',
      canaryHash: 'hash-v2',
    };
    const out = advance(
      baseInput({
        state,
        desiredHash: 'hash-v2',
        steps: [{ setWeight: 10 }, { pause: { duration: '5m' } }, { setWeight: 100 }],
        now: new Date('2026-05-08T12:01:00Z'), // only 1 minute elapsed
      }),
    );
    expect(out.actions).toEqual([{ kind: 'wait', reason: 'duration-not-elapsed' }]);
    expect(out.nextState.weight).toBe(10);
    expect(out.nextState.currentStepIndex).toBe(1);
  });

  it('progressing + pause elapsed: advances to next setWeight', () => {
    const earlier = new Date('2026-05-08T12:00:00Z');
    const state: RolloutState = {
      status: 'progressing',
      currentStepIndex: 1,
      startedAt: earlier.toISOString(),
      lastAdvanceAt: earlier.toISOString(),
      stableScript: NAMES.stableScriptName,
      canaryScript: NAMES.canaryScriptName,
      weight: 10,
      stableHash: 'hash-v1',
      canaryHash: 'hash-v2',
    };
    const out = advance(
      baseInput({
        state,
        desiredHash: 'hash-v2',
        steps: [{ setWeight: 10 }, { pause: { duration: '5m' } }, { setWeight: 50 }],
        now: new Date('2026-05-08T12:10:00Z'), // 10 minutes elapsed
      }),
    );
    expect(out.actions).toEqual([{ kind: 'set-weight', weight: 50 }]);
    expect(out.nextState.weight).toBe(50);
  });

  it('pause without duration: paused, manual-promote-needed', () => {
    const state: RolloutState = {
      status: 'progressing',
      currentStepIndex: 1,
      startedAt: '2026-05-08T12:00:00Z',
      lastAdvanceAt: '2026-05-08T12:00:00Z',
      stableScript: NAMES.stableScriptName,
      canaryScript: NAMES.canaryScriptName,
      weight: 50,
      stableHash: 'hash-v1',
      canaryHash: 'hash-v2',
    };
    const out = advance(
      baseInput({
        state,
        desiredHash: 'hash-v2',
        steps: [{ setWeight: 50 }, { pause: {} }, { setWeight: 100 }],
        now: new Date('2026-05-08T13:00:00Z'),
      }),
    );
    expect(out.actions).toEqual([{ kind: 'wait', reason: 'manual-promote-needed' }]);
    expect(out.nextState.status).toBe('paused');
  });

  it('setWeight 100: promotes canary to stable', () => {
    const state: RolloutState = {
      status: 'progressing',
      currentStepIndex: 1,
      startedAt: '2026-05-08T12:00:00Z',
      lastAdvanceAt: '2026-05-08T12:00:00Z',
      stableScript: NAMES.stableScriptName,
      canaryScript: NAMES.canaryScriptName,
      weight: 50,
      stableHash: 'hash-v1',
      canaryHash: 'hash-v2',
    };
    const out = advance(
      baseInput({
        state,
        desiredHash: 'hash-v2',
        steps: [{ setWeight: 50 }, { setWeight: 100 }],
        now: new Date('2026-05-08T12:10:00Z'),
      }),
    );
    expect(out.actions).toContainEqual({ kind: 'promote-canary', hash: 'hash-v2' });
    expect(out.actions).toContainEqual({ kind: 'remove-canary' });
    expect(out.nextState.stableHash).toBe('hash-v2');
    expect(out.nextState.canaryHash).toBeNull();
    expect(out.nextState.canaryScript).toBeNull();
    expect(out.nextState.status).toBe('idle');
    expect(out.nextState.weight).toBe(0);
  });

  it('mid-canary with new hash: aborts and restarts canary', () => {
    const state: RolloutState = {
      status: 'progressing',
      currentStepIndex: 1,
      startedAt: '2026-05-08T12:00:00Z',
      lastAdvanceAt: '2026-05-08T12:00:00Z',
      stableScript: NAMES.stableScriptName,
      canaryScript: NAMES.canaryScriptName,
      weight: 10,
      stableHash: 'hash-v1',
      canaryHash: 'hash-v2',
    };
    const out = advance(
      baseInput({
        state,
        desiredHash: 'hash-v3', // different from canaryHash
        steps: [{ setWeight: 25 }, { setWeight: 100 }],
        now: new Date('2026-05-08T12:30:00Z'),
      }),
    );
    expect(out.actions).toContainEqual({ kind: 'upload-canary', hash: 'hash-v3' });
    expect(out.actions).toContainEqual({ kind: 'set-weight', weight: 25 });
    expect(out.nextState.canaryHash).toBe('hash-v3');
  });

  it('empty steps → immediate cutover', () => {
    const out = advance(
      baseInput({
        state: idleStable('hash-v1'),
        desiredHash: 'hash-v2',
        steps: [],
      }),
    );
    expect(out.actions).toContainEqual({ kind: 'upload-canary', hash: 'hash-v2' });
    expect(out.actions).toContainEqual({ kind: 'promote-canary', hash: 'hash-v2' });
    expect(out.nextState.stableHash).toBe('hash-v2');
  });
});

describe('parseDurationMs', () => {
  it('parses ms / s / m / h / d', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('throws on bad input', () => {
    expect(() => parseDurationMs('foo')).toThrow();
    expect(() => parseDurationMs('5')).toThrow();
    expect(() => parseDurationMs('5y')).toThrow();
  });
});
