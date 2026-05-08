import { describe, it, expect, vi } from 'vitest';
import { runRolloutCommand, type RolloutCommandDeps } from './rollout-command.ts';
import type { RolloutState } from './state-machine.ts';

function makeDeps(initialKv?: Map<string, string>) {
  const store = initialKv ?? new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const deps: RolloutCommandDeps = {
    state: {
      read: vi.fn(async (k: string) => store.get(k) ?? null),
      write: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  };
  return { deps, store, out, err };
}

const SAMPLE_STATE: RolloutState = {
  status: 'paused',
  currentStepIndex: 2,
  startedAt: '2026-05-01T00:00:00Z',
  lastAdvanceAt: '2026-05-01T00:00:00Z',
  stableScript: 'k1c--default--api--stable',
  canaryScript: 'k1c--default--api--canary',
  weight: 50,
  stableHash: 'old-hash',
  canaryHash: 'new-hash',
};

describe('runRolloutCommand', () => {
  it('rejects malformed targets', async () => {
    const { deps, err } = makeDeps();
    const code = await runRolloutCommand({ subCommand: 'status', target: 'nope' }, deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/expected.*<namespace>\/<name>/);
  });

  describe('status', () => {
    it('reports "no state" when key absent', async () => {
      const { deps, out } = makeDeps();
      const code = await runRolloutCommand({ subCommand: 'status', target: 'default/api' }, deps);
      expect(code).toBe(0);
      expect(out.join('\n')).toMatch(/no rollout state/i);
    });

    it('prints state details when present', async () => {
      const store = new Map([['rollout/default/api', JSON.stringify(SAMPLE_STATE)]]);
      const { deps, out } = makeDeps(store);
      const code = await runRolloutCommand({ subCommand: 'status', target: 'default/api' }, deps);
      expect(code).toBe(0);
      const printed = out.join('\n');
      expect(printed).toMatch(/status:\s+paused/);
      expect(printed).toMatch(/weight:\s+50%/);
      expect(printed).toMatch(/canaryScript:.*k1c--default--api--canary/);
    });
  });

  describe('promote', () => {
    it('errors when state is missing', async () => {
      const { deps, err } = makeDeps();
      const code = await runRolloutCommand({ subCommand: 'promote', target: 'default/api' }, deps);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/nothing to promote/i);
    });

    it('errors when state is not paused', async () => {
      const store = new Map([
        [
          'rollout/default/api',
          JSON.stringify({ ...SAMPLE_STATE, status: 'progressing' }),
        ],
      ]);
      const { deps, err } = makeDeps(store);
      const code = await runRolloutCommand({ subCommand: 'promote', target: 'default/api' }, deps);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/promote only applies to "paused"/);
    });

    it('advances the step index, sets lastAdvanceAt to epoch, and writes back', async () => {
      const store = new Map([['rollout/default/api', JSON.stringify(SAMPLE_STATE)]]);
      const { deps, store: s, out } = makeDeps(store);
      const code = await runRolloutCommand({ subCommand: 'promote', target: 'default/api' }, deps);
      expect(code).toBe(0);
      const next = JSON.parse(s.get('rollout/default/api')!);
      expect(next.currentStepIndex).toBe(3);
      expect(next.status).toBe('progressing');
      expect(new Date(next.lastAdvanceAt).getTime()).toBe(0);
      expect(out.join('\n')).toMatch(/unpaused/);
    });
  });

  describe('abort', () => {
    it('errors when state is missing', async () => {
      const { deps, err } = makeDeps();
      const code = await runRolloutCommand({ subCommand: 'abort', target: 'default/api' }, deps);
      expect(code).toBe(1);
      expect(err.join('\n')).toMatch(/nothing to abort/i);
    });

    it('clears canary fields and resets to idle', async () => {
      const store = new Map([['rollout/default/api', JSON.stringify(SAMPLE_STATE)]]);
      const { deps, store: s } = makeDeps(store);
      const code = await runRolloutCommand({ subCommand: 'abort', target: 'default/api' }, deps);
      expect(code).toBe(0);
      const next = JSON.parse(s.get('rollout/default/api')!);
      expect(next.canaryScript).toBeNull();
      expect(next.canaryHash).toBeNull();
      expect(next.weight).toBe(0);
      expect(next.status).toBe('idle');
      expect(next.currentStepIndex).toBe(0);
    });
  });
});
