import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { accessApplicationProvider } from './access-application.ts';
import { NotFound } from './types.ts';
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
    zeroTrust: { access: { applications: mock } },
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

describe('accessApplicationProvider', () => {
  it('list filters apps by k1c- name prefix and decodes labels', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { id: 'app-1', name: 'k1c-prod-internal' },
        { id: 'app-2', name: 'someone-elses-app' },
        { id: 'app-3', name: 'k1c-default-public' },
      ]),
    );
    const result = await collect(accessApplicationProvider.list(buildCtx(mock)));
    expect(result).toEqual([
      { nativeId: 'app-1', label: 'prod/internal' },
      { nativeId: 'app-3', label: 'default/public' },
    ]);
  });

  it('create sends the app body with self_hosted type and inline policies', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'app-new' });
    await accessApplicationProvider.create(buildCtx(mock), 'prod/internal', {
      appName: 'k1c-prod-internal',
      domain: 'internal.example.com',
      appType: 'self_hosted',
      sessionDuration: '24h',
      policies: [
        {
          name: 'dev-allow',
          decision: 'allow',
          include: [{ email_domain: { domain: 'anthropic.com' } }],
        },
      ],
    });
    expect(mock.create).toHaveBeenCalledWith({
      account_id: 'acc-123',
      name: 'k1c-prod-internal',
      domain: 'internal.example.com',
      type: 'self_hosted',
      session_duration: '24h',
      policies: [
        {
          name: 'dev-allow',
          decision: 'allow',
          include: [{ email_domain: { domain: 'anthropic.com' } }],
        },
      ],
    });
  });

  it('forwards type=ssh through to the SDK request body', async () => {
    const mock = buildMock();
    mock.create.mockResolvedValueOnce({ id: 'app-ssh' });
    await accessApplicationProvider.create(buildCtx(mock), 'prod/jumpbox', {
      appName: 'k1c-prod-jumpbox',
      domain: 'ssh.example.com',
      appType: 'ssh',
      policies: [
        {
          name: 'allow',
          decision: 'allow',
          include: [{ everyone: {} }],
        },
      ],
    });
    expect(mock.create.mock.calls[0]![0].type).toBe('ssh');
  });

  it('read returns NotFound when SDK throws a 404-shaped error', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }));
    expect(await accessApplicationProvider.read(buildCtx(mock), 'app-x')).toBe(NotFound);
  });

  it('delete passes app id and account id to the SDK', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce(undefined);
    const result = await accessApplicationProvider.delete(buildCtx(mock), 'app-1');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('app-1', { account_id: 'acc-123' });
  });
});
