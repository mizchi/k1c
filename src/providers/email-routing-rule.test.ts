import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { emailRoutingRuleProvider } from './email-routing-rule.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls, zoneId = 'zone-abc'): ProviderContext {
  const cf = {
    emailRouting: { rules: mock },
  } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    zoneId,
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): MockCalls => ({
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
});

function pageOf<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          i < items.length
            ? Promise.resolve({ value: items[i++]!, done: false as const })
            : Promise.resolve({ value: undefined as unknown as T, done: true as const }),
      };
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('emailRoutingRuleProvider', () => {
  it('list filters rules by k1c: name prefix and recovers the label portion', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'r-1', name: 'k1c:default/forward-me|me-to-gmail' },
        { id: 'r-2', name: 'manual rule' },
      ]),
    );
    const result = await collect(emailRoutingRuleProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'r-1', label: 'default/forward-me' }]);
  });

  it('create encodes ownership label + user-facing name in the rule name field', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'r-new' });
    await emailRoutingRuleProvider.create(buildCtx(mock), 'default/forward-me', {
      zoneId: 'zone-abc',
      ruleName: 'me-to-gmail',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'me@example.com' }],
      actions: [{ type: 'forward', to: ['me@gmail.com'] }],
    });
    expect(mock.create).toHaveBeenCalledWith({
      zone_id: 'zone-abc',
      name: 'k1c:default/forward-me|me-to-gmail',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'me@example.com' }],
      actions: [{ type: 'forward', value: ['me@gmail.com'] }],
    });
  });

  it('encodes drop / worker actions into the SDK wire format', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'r-new' });
    await emailRoutingRuleProvider.create(buildCtx(mock), 'default/spam', {
      zoneId: 'zone-abc',
      ruleName: 'drop-spam',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', worker: 'k1c--default--inbox' }],
    });
    const sent = mock.create.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    expect(sent.actions).toEqual([{ type: 'worker', value: ['k1c--default--inbox'] }]);
  });

  it('update fetches the existing rule first to preserve ownership label, then PUTs', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      id: 'r-1',
      name: 'k1c:default/forward-me|me-to-gmail-old',
    });
    mock.update.mockResolvedValueOnce({ id: 'r-1' });
    await emailRoutingRuleProvider.update(
      buildCtx(mock),
      'r-1',
      {
        zoneId: 'zone-abc',
        ruleName: 'me-to-gmail-old',
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'drop' }],
      },
      {
        zoneId: 'zone-abc',
        ruleName: 'me-to-gmail-new',
        enabled: false,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'forward', to: ['me2@gmail.com'] }],
      },
    );
    const sent = mock.update.mock.calls[0]![1] as { name: string; enabled: boolean };
    // The new name reflects the user-facing rename, but the ownership label
    // is preserved from the existing rule's name.
    expect(sent.name).toBe('k1c:default/forward-me|me-to-gmail-new');
    expect(sent.enabled).toBe(false);
  });

  it('delete passes rule id and zone id to the SDK', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await emailRoutingRuleProvider.delete(buildCtx(mock), 'r-1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('r-1', { zone_id: 'zone-abc' });
  });
});
