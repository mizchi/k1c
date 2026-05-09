import { describe, expect, it } from 'vitest';
import { streamLiveInputProvider } from './stream-live-input.ts';
import type { ProviderContext } from './types.ts';

function fakeCtx(fakeLiveInputs: Record<string, unknown>): ProviderContext {
  return {
    cloudflare: { stream: { liveInputs: fakeLiveInputs } } as unknown as ProviderContext['cloudflare'],
    accountId: 'acct-1',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=test',
    signal: new AbortController().signal,
  };
}

describe('streamLiveInputProvider', () => {
  it('list yields only k1c-managed live inputs (meta marker)', async () => {
    const ctx = fakeCtx({
      list: async () => ({
        liveInputs: [
          { uid: 'a', meta: { 'k1c.io/managed': 'default/cam' } },
          { uid: 'b', meta: { description: 'hand-crafted, not ours' } },
          { uid: 'c', meta: null },
          { uid: 'd', meta: { 'k1c.io/managed': 'media/encore' } },
        ],
      }),
    });
    const out = [];
    for await (const r of streamLiveInputProvider.list(ctx)) out.push(r);
    expect(out).toEqual([
      { nativeId: 'a', label: 'default/cam' },
      { nativeId: 'd', label: 'media/encore' },
    ]);
  });

  it('create stamps the ownership marker into meta', async () => {
    let captured: { meta?: Record<string, string> } | undefined;
    const ctx = fakeCtx({
      create: async (body: { meta?: Record<string, string> }) => {
        captured = body;
        return { uid: 'new-uid' };
      },
    });
    await streamLiveInputProvider.create(ctx, 'media/cam-1', {
      recording: { mode: 'automatic', allowedOrigins: ['example.com'] },
      meta: { description: 'main entrance' },
    });
    expect(captured?.meta).toEqual({
      description: 'main entrance',
      'k1c.io/managed': 'media/cam-1',
    });
  });

  it('read strips the ownership marker from returned meta', async () => {
    const ctx = fakeCtx({
      get: async () => ({
        uid: 'x',
        meta: {
          'k1c.io/managed': 'ns/a',
          purpose: 'public livestream',
        },
        recording: { mode: 'automatic' },
      }),
    });
    const result = await streamLiveInputProvider.read(ctx, 'x');
    expect(result).toEqual({
      meta: { purpose: 'public livestream' },
      recording: { mode: 'automatic' },
    });
  });

  it('update preserves the ownership marker from the existing record', async () => {
    let updateBody: { meta?: Record<string, string> } | undefined;
    const ctx = fakeCtx({
      get: async () => ({ uid: 'x', meta: { 'k1c.io/managed': 'media/cam-1' } }),
      update: async (_id: string, body: { meta?: Record<string, string> }) => {
        updateBody = body;
        return {};
      },
    });
    await streamLiveInputProvider.update(ctx, 'x', {} as never, {
      recording: { mode: 'off' },
    });
    expect(updateBody?.meta).toEqual({ 'k1c.io/managed': 'media/cam-1' });
  });

  it('delete is idempotent on 404', async () => {
    const ctx = fakeCtx({
      delete: async () => {
        throw { status: 404 };
      },
    });
    const r = await streamLiveInputProvider.delete(ctx, 'gone');
    expect(r).toEqual({ kind: 'sync' });
  });
});
