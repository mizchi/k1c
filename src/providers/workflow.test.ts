import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { workflowProvider } from './workflow.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

interface MockCalls {
  readonly update: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
}

function buildCtx(mock: MockCalls): ProviderContext {
  const cf = { workflows: mock } as unknown as Cloudflare;
  return {
    cloudflare: cf,
    accountId: 'acc-123',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

const buildMock = (): MockCalls => ({
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

describe('workflowProvider', () => {
  it('list yields only workflows with k1c- prefix', async () => {
    const mock = buildMock();
    mock.list.mockReturnValueOnce(
      pageOf([
        { name: 'k1c-default-import' },
        { name: 'unmanaged-flow' },
      ]),
    );
    const result = await collect(workflowProvider.list(buildCtx(mock)));
    expect(result).toEqual([{ nativeId: 'k1c-default-import', label: 'default/import' }]);
  });

  it('read parses workflow registration', async () => {
    const mock = buildMock();
    mock.get.mockResolvedValueOnce({
      name: 'k1c-default-import',
      class_name: 'ImportFlow',
      script_name: 'k1c--default--import',
    });
    const props = await workflowProvider.read(buildCtx(mock), 'k1c-default-import');
    expect(props).toEqual({
      workflowName: 'k1c-default-import',
      className: 'ImportFlow',
      scriptName: 'k1c--default--import',
    });
  });

  it('read returns NotFound on 404', async () => {
    const mock = buildMock();
    mock.get.mockRejectedValueOnce({ status: 404, message: 'gone' });
    expect(await workflowProvider.read(buildCtx(mock), 'k1c-default-import')).toBe(NotFound);
  });

  it('create issues workflows.update (PUT-style upsert)', async () => {
    const mock = buildMock();
    mock.update.mockResolvedValueOnce({});
    await workflowProvider.create(buildCtx(mock), 'default/import', {
      workflowName: 'k1c-default-import',
      className: 'ImportFlow',
      scriptName: 'k1c--default--import',
    });
    expect(mock.update).toHaveBeenCalledWith('k1c-default-import', {
      account_id: 'acc-123',
      class_name: 'ImportFlow',
      script_name: 'k1c--default--import',
    });
  });

  it('delete calls SDK with workflow name', async () => {
    const mock = buildMock();
    mock.delete.mockResolvedValueOnce({});
    const result = await workflowProvider.delete(buildCtx(mock), 'k1c-default-import');
    expect(result).toEqual({ kind: 'sync' });
    expect(mock.delete).toHaveBeenCalledWith('k1c-default-import', { account_id: 'acc-123' });
  });
});
