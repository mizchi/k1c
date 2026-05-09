import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { cacheRuleProvider } from './cache-rule.ts';
import type { ProviderContext } from './types.ts';

interface PhaseMock {
  readonly get: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: PhaseMock, zoneId: string | undefined = 'zone-abc'): ProviderContext {
  const cf = { rulesets: { phases: mock } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    ...(zoneId !== undefined ? { zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): PhaseMock => ({ get: vi.fn(), update: vi.fn() });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('cacheRuleProvider', () => {
  it('list filters rules by k1c.io/managed= description marker', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      rules: [
        {
          id: 'r-1',
          action: 'set_cache_settings',
          description: 'k1c.io/managed=prod/static',
          expression: 'true',
        },
        {
          id: 'r-2',
          action: 'set_cache_settings',
          description: 'manual rule someone else owns',
          expression: 'true',
        },
        {
          id: 'r-3',
          action: 'set_cache_settings',
          description: 'k1c.io/managed=default/api: with note',
          expression: 'true',
        },
      ],
    });
    const result = await collect(cacheRuleProvider.list(buildCtx(mock)));
    expect(result).toEqual([
      { nativeId: 'r-1', label: 'prod/static' },
      { nativeId: 'r-3', label: 'default/api' },
    ]);
  });

  it('create appends a new rule preserving existing non-k1c rules', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      rules: [{ id: 'r-existing', action: 'set_cache_settings', description: 'manual', expression: 'true' }],
    });
    mock.update.mockImplementationOnce((_phase: unknown, params: { rules: unknown }) => {
      // Simulate Cloudflare assigning ids to new rules.
      const rules = (params.rules as Array<{ id?: string; description?: string }>).map((r) =>
        r.id ? r : { ...r, id: 'r-new' },
      );
      return Promise.resolve({ rules });
    });
    const result = await cacheRuleProvider.create(buildCtx(mock), 'prod/static', {
      zoneId: 'zone-abc',
      expression: 'true',
      cache: true,
      enabled: true,
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'r-new' });
    expect(mock.update).toHaveBeenCalledTimes(1);
    const sentRules = mock.update.mock.calls[0]![1].rules as Array<{
      description?: string;
      action?: string;
      action_parameters?: { cache?: boolean };
    }>;
    expect(sentRules).toHaveLength(2);
    expect(sentRules[0]!.description).toBe('manual');
    expect(sentRules[1]!.description).toBe('k1c.io/managed=prod/static');
    expect(sentRules[1]!.action_parameters?.cache).toBe(true);
  });

  it('update replaces the rule in place by native id', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      rules: [
        { id: 'r-1', action: 'set_cache_settings', description: 'k1c.io/managed=prod/x', expression: 'old' },
        { id: 'r-2', action: 'set_cache_settings', description: 'manual', expression: 'true' },
      ],
    });
    mock.update.mockResolvedValueOnce({
      rules: [
        { id: 'r-1', action: 'set_cache_settings', description: 'k1c.io/managed=prod/x', expression: 'new' },
        { id: 'r-2', action: 'set_cache_settings', description: 'manual', expression: 'true' },
      ],
    });
    await cacheRuleProvider.update(
      buildCtx(mock),
      'r-1',
      { zoneId: 'zone-abc', expression: 'old', cache: true, enabled: true },
      { zoneId: 'zone-abc', expression: 'new', cache: false, enabled: true },
    );
    const sent = mock.update.mock.calls[0]![1].rules as Array<{ id?: string; expression?: string }>;
    expect(sent).toHaveLength(2);
    expect(sent.find((r) => r.id === 'r-1')!.expression).toBe('new');
  });

  it('delete drops the rule and PUTs the rest back', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      rules: [
        { id: 'r-1', action: 'set_cache_settings', description: 'k1c.io/managed=p/x', expression: 'true' },
        { id: 'r-2', action: 'set_cache_settings', description: 'manual', expression: 'true' },
      ],
    });
    mock.update.mockResolvedValueOnce({ rules: [] });
    const result = await cacheRuleProvider.delete(buildCtx(mock), 'r-1');
    expect(result).toEqual({ kind: 'sync' });
    const sent = mock.update.mock.calls[0]![1].rules as Array<{ id?: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe('r-2');
  });

  it('delete returns success when the rule is already gone (idempotent)', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({ rules: [] });
    const result = await cacheRuleProvider.delete(buildCtx(mock), 'r-gone');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.update).not.toHaveBeenCalled();
  });
});
