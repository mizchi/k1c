import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workerCronTriggerProvider } from './worker-cron-trigger.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly update: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = {
    workers: { scripts: { schedules: mock } },
  } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-1',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): MockCalls => ({
  update: vi.fn(),
  get: vi.fn(),
});

describe('workerCronTriggerProvider', () => {
  it('create PUTs the schedule list as { cron } objects', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({ schedules: [] });
    const result = await workerCronTriggerProvider.create(buildCtx(mock), 'default/hourly', {
      scriptName: 'cleanup-worker',
      schedules: ['0 * * * *', '*/15 * * * *'],
    });
    expect(mock.update).toHaveBeenCalledWith('cleanup-worker', {
      account_id: 'acc-1',
      body: [{ cron: '0 * * * *' }, { cron: '*/15 * * * *' }],
    });
    expect(result).toMatchObject({
      kind: 'sync',
      nativeId: 'cleanup-worker',
    });
  });

  it('read returns the scriptName + schedules from the script', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      schedules: [{ cron: '0 0 * * *' }, { cron: '@daily' }],
    });
    const props = await workerCronTriggerProvider.read(buildCtx(mock), 'reporter');
    expect(props).toEqual({
      scriptName: 'reporter',
      schedules: ['0 0 * * *', '@daily'],
    });
  });

  it('read returns NotFound when the script is missing', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce({ status: 404, message: 'script not found' });
    const result = await workerCronTriggerProvider.read(buildCtx(mock), 'gone');
    expect(result).toBe(NotFound);
  });

  it('update PUTs the new schedule list under the same scriptName', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({ schedules: [] });
    await workerCronTriggerProvider.update(
      buildCtx(mock),
      'reporter',
      { scriptName: 'reporter', schedules: ['0 * * * *'] },
      { scriptName: 'reporter', schedules: ['*/5 * * * *'] },
    );
    expect(mock.update).toHaveBeenCalledWith('reporter', {
      account_id: 'acc-1',
      body: [{ cron: '*/5 * * * *' }],
    });
  });

  it('delete clears every trigger by PUTting an empty body', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({ schedules: [] });
    await workerCronTriggerProvider.delete(buildCtx(mock), 'reporter');
    expect(mock.update).toHaveBeenCalledWith('reporter', {
      account_id: 'acc-1',
      body: [],
    });
  });

  it('equals ignores schedule ordering', () => {
    expect(workerCronTriggerProvider.equals).toBeDefined();
    const eq = workerCronTriggerProvider.equals!;
    expect(
      eq(
        { scriptName: 's', schedules: ['0 * * * *', '*/5 * * * *'] },
        { scriptName: 's', schedules: ['*/5 * * * *', '0 * * * *'] },
      ),
    ).toBe(true);
  });

  it('list yields nothing (drift handled via read on known scriptNames)', async () => {
    const items: unknown[] = [];
    for await (const x of workerCronTriggerProvider.list(buildCtx(buildMock()))) {
      items.push(x);
    }
    expect(items).toEqual([]);
  });
});
