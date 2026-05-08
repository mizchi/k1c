import { describe, it, expect, vi } from 'vitest';
import { bundleHash, runCanaryAdvance, type RuntimeDeps } from './runtime.ts';
import type { WorkerProperties } from '../providers/worker.ts';
import type { Rollout } from '../manifest/types.ts';

function mkRollout(steps: Array<{ setWeight: number } | { pause: { duration?: string } }>): Rollout {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Rollout',
    metadata: {
      name: 'api',
      namespace: 'default',
      annotations: { 'cloudflare.com/dispatch-namespace': 'production' },
    },
    spec: {
      selector: { matchLabels: { app: 'api' } },
      template: { spec: { containers: [{ name: 'api', image: './dist/worker.js' }] } },
      strategy: { canary: { steps } },
    },
  };
}

const stableProps: WorkerProperties = {
  scriptName: 'k1c--default--api--stable',
  entrypoint: './dist/worker.js',
  compatibilityDate: '2025-06-01',
  dispatchNamespace: 'k1c-default-production',
};

function makeFakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      read: vi.fn(async (k: string) => store.get(k) ?? null),
      write: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
  };
}

function makeFakeEffects() {
  return {
    uploadCanary: vi.fn(async () => {}),
    promoteCanaryToStable: vi.fn(async () => {}),
    removeCanary: vi.fn(async () => {}),
  };
}

function makeDeps(now = new Date('2026-05-08T12:00:00Z')): RuntimeDeps & {
  kv: ReturnType<typeof makeFakeKv>;
  effects: ReturnType<typeof makeFakeEffects>;
} {
  const kv = makeFakeKv();
  const effects = makeFakeEffects();
  return {
    state: kv.client,
    effects,
    now: () => now,
    kv,
  };
}

describe('runCanaryAdvance', () => {
  it('first apply writes initial idle state and emits no canary actions', async () => {
    const deps = makeDeps();
    const reports = await runCanaryAdvance(
      [
        {
          rollout: mkRollout([{ setWeight: 10 }, { setWeight: 100 }]),
          stableProps,
          entrypointContent: new TextEncoder().encode('// v1'),
        },
      ],
      deps,
    );
    expect(reports[0]!.previousStatus).toBe('absent');
    expect(reports[0]!.nextStatus).toBe('idle');
    expect(deps.effects.uploadCanary).not.toHaveBeenCalled();
    const stored = deps.kv.store.get('rollout/default/api');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.status).toBe('idle');
    expect(parsed.stableHash).toBeTruthy();
  });

  it('apply with new content uploads canary and writes progressing state', async () => {
    const deps = makeDeps();
    // Seed initial idle state
    deps.kv.store.set(
      'rollout/default/api',
      JSON.stringify({
        status: 'idle',
        currentStepIndex: 0,
        startedAt: null,
        lastAdvanceAt: null,
        stableScript: 'k1c--default--api--stable',
        canaryScript: null,
        weight: 0,
        stableHash: 'hash-old',
        canaryHash: null,
      }),
    );
    const reports = await runCanaryAdvance(
      [
        {
          rollout: mkRollout([{ setWeight: 10 }, { setWeight: 100 }]),
          stableProps,
          entrypointContent: new TextEncoder().encode('// new content'),
        },
      ],
      deps,
    );
    expect(deps.effects.uploadCanary).toHaveBeenCalledOnce();
    const uploadArg = (deps.effects.uploadCanary.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(uploadArg).toBeDefined();
    expect(uploadArg!.scriptName).toBe('k1c--default--api--canary');
    expect(uploadArg!.dispatchNamespace).toBe('k1c-default-production');
    expect(reports[0]!.nextStatus).toBe('progressing');
    expect(reports[0]!.nextWeight).toBe(10);
  });

  it('apply on a setWeight=100 step promotes canary and removes it', async () => {
    const deps = makeDeps();
    deps.kv.store.set(
      'rollout/default/api',
      JSON.stringify({
        status: 'progressing',
        currentStepIndex: 1, // step 0 was setWeight 10 (already applied)
        startedAt: '2026-05-08T11:00:00Z',
        lastAdvanceAt: '2026-05-08T11:00:00Z',
        stableScript: 'k1c--default--api--stable',
        canaryScript: 'k1c--default--api--canary',
        weight: 10,
        stableHash: 'hash-old',
        canaryHash: bundleHash(stableProps, new TextEncoder().encode('// new content')),
      }),
    );
    const reports = await runCanaryAdvance(
      [
        {
          rollout: mkRollout([{ setWeight: 10 }, { setWeight: 100 }]),
          stableProps,
          entrypointContent: new TextEncoder().encode('// new content'),
        },
      ],
      deps,
    );
    expect(deps.effects.promoteCanaryToStable).toHaveBeenCalledOnce();
    expect(deps.effects.removeCanary).toHaveBeenCalledOnce();
    expect(reports[0]!.nextStatus).toBe('idle');
    const finalState = JSON.parse(deps.kv.store.get('rollout/default/api')!);
    expect(finalState.canaryHash).toBeNull();
  });

  it('paused state with no manifest change keeps state paused, no upload', async () => {
    const deps = makeDeps();
    const canaryHash = bundleHash(stableProps, new TextEncoder().encode('// new content'));
    deps.kv.store.set(
      'rollout/default/api',
      JSON.stringify({
        status: 'progressing',
        currentStepIndex: 1, // pointing at the pause:{} step
        startedAt: '2026-05-08T11:00:00Z',
        lastAdvanceAt: '2026-05-08T11:00:00Z',
        stableScript: 'k1c--default--api--stable',
        canaryScript: 'k1c--default--api--canary',
        weight: 50,
        stableHash: 'hash-old',
        canaryHash,
      }),
    );
    await runCanaryAdvance(
      [
        {
          rollout: mkRollout([{ setWeight: 50 }, { pause: {} }, { setWeight: 100 }]),
          stableProps,
          entrypointContent: new TextEncoder().encode('// new content'),
        },
      ],
      deps,
    );
    expect(deps.effects.uploadCanary).not.toHaveBeenCalled();
    const finalState = JSON.parse(deps.kv.store.get('rollout/default/api')!);
    expect(finalState.status).toBe('paused');
  });

  it('throws when stable WorkerProperties is missing dispatchNamespace', async () => {
    const deps = makeDeps();
    const propsNoNs: WorkerProperties = { ...stableProps, dispatchNamespace: undefined } as never;
    await expect(
      runCanaryAdvance(
        [
          {
            rollout: mkRollout([{ setWeight: 100 }]),
            stableProps: propsNoNs,
            entrypointContent: new TextEncoder().encode('// any'),
          },
        ],
        deps,
      ),
    ).rejects.toThrow(/dispatchNamespace/);
  });
});

describe('bundleHash', () => {
  it('changes when entrypoint content changes', () => {
    const a = bundleHash(stableProps, new TextEncoder().encode('// v1'));
    const b = bundleHash(stableProps, new TextEncoder().encode('// v2'));
    expect(a).not.toBe(b);
  });

  it('changes when vars change', () => {
    const content = new TextEncoder().encode('// same');
    const a = bundleHash({ ...stableProps, vars: { K: '1' } }, content);
    const b = bundleHash({ ...stableProps, vars: { K: '2' } }, content);
    expect(a).not.toBe(b);
  });

  it('is stable across object key reorderings', () => {
    const content = new TextEncoder().encode('// same');
    const a = bundleHash({ ...stableProps, vars: { A: '1', B: '2' } }, content);
    const b = bundleHash({ ...stableProps, vars: { B: '2', A: '1' } }, content);
    expect(a).toBe(b);
  });
});
