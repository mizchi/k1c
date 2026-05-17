import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { turnstileWidgetProvider } from './turnstile-widget.ts';
import { snippetProvider } from './snippet.ts';
import { streamKeyProvider } from './stream-key.ts';
import { streamWatermarkProvider } from './stream-watermark.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function makeCtx(cf: unknown): ProviderContext {
  return {
    cloudflare: cf as Cloudflare,
    accountId: 'acc',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

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

describe('turnstileWidgetProvider', () => {
  it('list yields k1c-prefixed widgets only', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { sitekey: 'sk-1', name: 'k1c-prod-checkout' },
        { sitekey: 'sk-2', name: 'someone-elses-widget' },
        { sitekey: 'sk-3', name: 'k1c-default-login' },
      ]),
    );
    const result = await collect(
      turnstileWidgetProvider.list(makeCtx({ turnstile: { widgets: { list } } })),
    );
    expect(result).toEqual([
      { nativeId: 'sk-1', label: 'prod/checkout' },
      { nativeId: 'sk-3', label: 'default/login' },
    ]);
  });

  it('create POSTs the body and returns the sitekey as nativeId', async () => {
    const create = vi.fn().mockResolvedValue({ sitekey: 'sk-new' });
    const r = await turnstileWidgetProvider.create(
      makeCtx({ turnstile: { widgets: { create } } }),
      'app/x',
      {
        widgetName: 'k1c-app-x',
        domains: ['example.com', 'app.example.com'],
        mode: 'managed',
        botFightMode: true,
      },
    );
    expect(create).toHaveBeenCalledWith({
      account_id: 'acc',
      name: 'k1c-app-x',
      domains: ['example.com', 'app.example.com'],
      mode: 'managed',
      bot_fight_mode: true,
    });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'sk-new' });
  });

  it('equals normalizes domain ordering and unspecified bools', () => {
    const eq = turnstileWidgetProvider.equals!;
    expect(
      eq(
        { widgetName: 'w', domains: ['a', 'b'], mode: 'managed' },
        { widgetName: 'w', domains: ['b', 'a'], mode: 'managed', botFightMode: false },
      ),
    ).toBe(true);
  });
});

describe('snippetProvider', () => {
  it('create uploads multipart with metadata + file part keyed by mainModule', async () => {
    const update = vi.fn().mockResolvedValue({});
    await snippetProvider.create(
      makeCtx({ snippets: { update, get: vi.fn(), delete: vi.fn() } }),
      'cdn/redirect',
      {
        zoneId: 'zone-1',
        snippetName: 'redirect',
        mainModule: 'snippet.js',
        content: 'export default {}',
      },
    );
    expect(update).toHaveBeenCalled();
    const [name, params] = update.mock.calls[0]!;
    expect(name).toBe('redirect');
    const p = params as Record<string, unknown>;
    expect(p['zone_id']).toBe('zone-1');
    expect((p['metadata'] as File).name).toBe('metadata');
    expect((p['snippet.js'] as File).name).toBe('snippet.js');
  });

  it('delete routes the nativeId split back into the right args', async () => {
    const del = vi.fn().mockResolvedValue({});
    await snippetProvider.delete(
      makeCtx({ snippets: { update: vi.fn(), get: vi.fn(), delete: del } }),
      'zone-1::redirect',
    );
    expect(del).toHaveBeenCalledWith('redirect', { zone_id: 'zone-1' });
  });
});

describe('streamKeyProvider', () => {
  it('create returns the issued id as nativeId', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'key-abc' });
    const r = await streamKeyProvider.create(
      makeCtx({ stream: { keys: { create, get: vi.fn(), delete: vi.fn() } } }),
      'media/signing',
      {},
    );
    expect(create).toHaveBeenCalledWith({ account_id: 'acc', body: {} });
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'key-abc' });
  });

  it('update is a no-op (keys are immutable)', async () => {
    const r = await streamKeyProvider.update(
      makeCtx({ stream: { keys: {} } }),
      'key-abc',
      {},
      {},
    );
    expect(r).toEqual({ kind: 'noop' });
  });

  it('delete removes the key by id', async () => {
    const del = vi.fn().mockResolvedValue({});
    await streamKeyProvider.delete(
      makeCtx({ stream: { keys: { create: vi.fn(), get: vi.fn(), delete: del } } }),
      'key-abc',
    );
    expect(del).toHaveBeenCalledWith('key-abc', { account_id: 'acc' });
  });

  it('read returns NotFound when the id is missing from the paginated list', async () => {
    const get = vi.fn().mockReturnValue(pageOf([{ id: 'other' }]));
    const r = await streamKeyProvider.read(
      makeCtx({ stream: { keys: { create: vi.fn(), get, delete: vi.fn() } } }),
      'key-gone',
    );
    expect(r).toBe(NotFound);
  });
});

describe('streamWatermarkProvider', () => {
  it('create reads the image file via ctx.readFile and POSTs it', async () => {
    const create = vi.fn().mockResolvedValue({ uid: 'wm-1' });
    const readFile = vi.fn().mockResolvedValue(new TextEncoder().encode('fake-png-bytes'));
    const ctx: ProviderContext = {
      ...makeCtx({ stream: { watermarks: { create, list: vi.fn(), delete: vi.fn(), get: vi.fn() } } }),
      readFile,
    };
    const r = await streamWatermarkProvider.create(ctx, 'media/intro', {
      profileName: 'k1c-media-intro',
      filePath: './watermark.png',
      opacity: 0.5,
      position: 'lowerRight',
    });
    expect(readFile).toHaveBeenCalledWith('./watermark.png');
    expect(create).toHaveBeenCalled();
    const params = create.mock.calls[0]![0]! as Record<string, unknown>;
    expect(params['account_id']).toBe('acc');
    expect(params['name']).toBe('k1c-media-intro');
    expect(params['opacity']).toBe(0.5);
    expect(params['position']).toBe('lowerRight');
    expect(r).toMatchObject({ kind: 'sync', nativeId: 'wm-1' });
  });

  it('update rejects with NotUpdatable + recreate', async () => {
    await expect(
      streamWatermarkProvider.update(
        makeCtx({ stream: { watermarks: {} } }),
        'wm-1',
        { profileName: 'a', filePath: './a.png' },
        { profileName: 'a', filePath: './b.png' },
      ),
    ).rejects.toMatchObject({ code: 'NotUpdatable', suggest: 'recreate' });
  });

  it('list returns NotFound mappings for non-k1c-prefixed entries', async () => {
    const list = vi.fn().mockReturnValue(
      pageOf([
        { uid: 'wm-1', name: 'k1c-media-intro' },
        { uid: 'wm-2', name: 'team-other-watermark' },
      ]),
    );
    const result = await collect(
      streamWatermarkProvider.list(
        makeCtx({ stream: { watermarks: { list, create: vi.fn(), delete: vi.fn(), get: vi.fn() } } }),
      ),
    );
    expect(result).toEqual([{ nativeId: 'wm-1', label: 'media/intro' }]);
  });
});

describe('NotFound passthrough', () => {
  it('turnstile read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await turnstileWidgetProvider.read(
      makeCtx({ turnstile: { widgets: { get } } }),
      'sk-gone',
    );
    expect(r).toBe(NotFound);
  });

  it('snippet read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const r = await snippetProvider.read(
      makeCtx({ snippets: { get } }),
      'zone-1::gone',
    );
    expect(r).toBe(NotFound);
  });
});
