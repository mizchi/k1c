import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { accessPolicyProvider } from './access-policy.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = {
    zeroTrust: { access: { policies: mock } },
  } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
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

describe('accessPolicyProvider', () => {
  it('list filters policies by k1c- name prefix and decodes labels', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'p-1', name: 'k1c-prod-dev-allow' },
        { id: 'p-2', name: 'someone-elses-policy' },
        { id: 'p-3', name: 'k1c-default-bypass' },
      ]),
    );
    const result = await collect(accessPolicyProvider.list(buildCtx(mock)));
    expect(result).toEqual([
      { nativeId: 'p-1', label: 'prod/dev-allow' },
      { nativeId: 'p-3', label: 'default/bypass' },
    ]);
  });

  it('create sends policy body with snake_case wire shape', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'p-new' });
    await accessPolicyProvider.create(buildCtx(mock), 'prod/dev-allow', {
      policyName: 'k1c-prod-dev-allow',
      decision: 'allow',
      include: [{ email_domain: { domain: 'anthropic.com' } }],
      sessionDuration: '8h',
    });
    expect(mock.create).toHaveBeenCalledWith({
      account_id: 'acc-123',
      name: 'k1c-prod-dev-allow',
      decision: 'allow',
      include: [{ email_domain: { domain: 'anthropic.com' } }],
      session_duration: '8h',
    });
  });

  it('delete passes policy id and account id to the SDK', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await accessPolicyProvider.delete(buildCtx(mock), 'p-1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('p-1', { account_id: 'acc-123' });
  });
});
