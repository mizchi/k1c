import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { queueProvider } from './queue.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly create: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

interface ConsumersMock {
  readonly create: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls, consumers: ConsumersMock): ProviderContext {
  const cf = { queues: { ...mock, consumers } } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildQueuesMock = (): MockCalls => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
});
const buildConsumersMock = (): ConsumersMock => ({ create: vi.fn() });

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

describe('queueProvider', () => {
  it('list yields only queues with k1c- prefix', async () => {
    const queues = buildQueuesMock();
    queues.list.mockReturnValueOnce(
      pageOf([
        { queue_id: 'q1', queue_name: 'k1c-default-jobs' },
        { queue_id: 'q2', queue_name: 'unmanaged' },
      ]),
    );
    const result = await collect(queueProvider.list(buildCtx(queues, buildConsumersMock())));
    expect(result).toEqual([{ nativeId: 'q1', label: 'default/jobs' }]);
  });

  it('read picks up the first Worker consumer', async () => {
    const queues = buildQueuesMock();
    queues.get.mockResolvedValueOnce({
      queue_id: 'q1',
      queue_name: 'k1c-default-jobs',
      consumers: [{ script: 'k1c--default--worker' }],
    });
    const props = await queueProvider.read(buildCtx(queues, buildConsumersMock()), 'q1');
    expect(props).toEqual({
      queueName: 'k1c-default-jobs',
      consumerWorkerName: 'k1c--default--worker',
    });
  });

  it('read returns NotFound on 404', async () => {
    const queues = buildQueuesMock();
    queues.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
    expect(await queueProvider.read(buildCtx(queues, buildConsumersMock()), 'q1')).toBe(
      NotFound,
    );
  });

  it('create with consumer registers via consumers.create', async () => {
    const queues = buildQueuesMock();
    const consumers = buildConsumersMock();
    queues.create.mockResolvedValueOnce({ queue_id: 'q-new' });
    consumers.create.mockResolvedValueOnce({});
    const result = await queueProvider.create(buildCtx(queues, consumers), 'default/jobs', {
      queueName: 'k1c-default-jobs',
      consumerWorkerName: 'k1c--default--worker',
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'q-new' });
    expect(consumers.create).toHaveBeenCalledWith(
      'q-new',
      expect.objectContaining({
        account_id: 'acc-123',
        type: 'worker',
        script_name: 'k1c--default--worker',
      }),
    );
  });

  it('update with changed queueName throws NotUpdatable', async () => {
    const queues = buildQueuesMock();
    await expect(
      queueProvider.update(
        buildCtx(queues, buildConsumersMock()),
        'q1',
        { queueName: 'k1c-default-old' },
        { queueName: 'k1c-default-new' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('delete calls SDK with queue id', async () => {
    const queues = buildQueuesMock();
    queues.delete.mockResolvedValueOnce(undefined);
    const result = await queueProvider.delete(buildCtx(queues, buildConsumersMock()), 'q1');
    expect(result).toEqual({ kind: 'sync' });
    expect(queues.delete).toHaveBeenCalledWith('q1', { account_id: 'acc-123' });
  });
});
