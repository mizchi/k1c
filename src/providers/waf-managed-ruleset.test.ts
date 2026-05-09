import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { wafManagedRulesetProvider } from './waf-managed-ruleset.ts';
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

describe('wafManagedRulesetProvider', () => {
  it('list filters execute rules by k1c.io/managed= description marker', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      rules: [
        {
          id: 'r-1',
          action: 'execute',
          action_parameters: { id: 'efb7b8c949ac4650a09736fc376e9aee' },
          description: 'k1c.io/managed=prod/owasp',
          expression: 'true',
        },
        { id: 'r-2', action: 'execute', description: 'manual', expression: 'true' },
      ],
    });
    const result = await collect(wafManagedRulesetProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'r-1', label: 'prod/owasp' }]);
  });

  it('create appends an execute rule with the managed ruleset id and override action', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({ rules: [] });
    mock.update.mockImplementationOnce((_phase: unknown, params: { rules: unknown }) => {
      const rules = (params.rules as Array<{ id?: string; description?: string }>).map((r, i) => ({
        ...r,
        id: r.id ?? `r-new-${i}`,
      }));
      return Promise.resolve({ rules });
    });
    await wafManagedRulesetProvider.create(buildCtx(mock), 'prod/owasp', {
      zoneId: 'zone-abc',
      rulesetId: 'efb7b8c949ac4650a09736fc376e9aee',
      enabled: true,
      overrideAction: 'log',
    });
    const sent = mock.update.mock.calls[0]![1].rules as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      action: 'execute',
      action_parameters: {
        id: 'efb7b8c949ac4650a09736fc376e9aee',
        overrides: { action: 'log' },
      },
      enabled: true,
      expression: 'true',
    });
  });
});
