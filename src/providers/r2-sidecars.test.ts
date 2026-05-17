import { describe, it, expect, vi } from 'vitest';
import type Cloudflare from 'cloudflare';
import { r2BucketCorsProvider } from './r2-bucket-cors.ts';
import { r2BucketLifecycleProvider } from './r2-bucket-lifecycle.ts';
import { r2BucketEventNotificationProvider } from './r2-bucket-event-notification.ts';
import { r2CustomDomainProvider } from './r2-custom-domain.ts';
import { NotFound } from './types.ts';
import type { ProviderContext } from './types.ts';

function makeCtx(r2: unknown): ProviderContext {
  return {
    cloudflare: { r2 } as unknown as Cloudflare,
    accountId: 'acc',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
  };
}

describe('r2BucketCorsProvider', () => {
  it('create PUTs the rule array to the cors endpoint', async () => {
    const update = vi.fn().mockResolvedValue({});
    await r2BucketCorsProvider.create(
      makeCtx({ buckets: { cors: { update, get: vi.fn(), delete: vi.fn() } } }),
      'app/media',
      {
        bucketName: 'media',
        rules: [
          { allowed: { methods: ['GET'], origins: ['https://example.com'] }, maxAgeSeconds: 60 },
        ],
      },
    );
    expect(update).toHaveBeenCalledWith('media', {
      account_id: 'acc',
      rules: [
        { allowed: { methods: ['GET'], origins: ['https://example.com'] }, maxAgeSeconds: 60 },
      ],
    });
  });

  it('read maps the API shape back into the manifest shape', async () => {
    const get = vi.fn().mockResolvedValue({
      rules: [
        {
          id: 'r1',
          allowed: { methods: ['GET', 'HEAD'], origins: ['*'], headers: ['x-trace'] },
          exposeHeaders: ['etag'],
          maxAgeSeconds: 3600,
        },
      ],
    });
    const props = await r2BucketCorsProvider.read(
      makeCtx({ buckets: { cors: { get, update: vi.fn(), delete: vi.fn() } } }),
      'media',
    );
    expect(props).toEqual({
      bucketName: 'media',
      rules: [
        {
          id: 'r1',
          allowed: { methods: ['GET', 'HEAD'], origins: ['*'], headers: ['x-trace'] },
          exposeHeaders: ['etag'],
          maxAgeSeconds: 3600,
        },
      ],
    });
  });

  it('read returns NotFound on 404', async () => {
    const get = vi.fn().mockRejectedValue({ status: 404, message: 'not found' });
    const result = await r2BucketCorsProvider.read(
      makeCtx({ buckets: { cors: { get, update: vi.fn(), delete: vi.fn() } } }),
      'gone',
    );
    expect(result).toBe(NotFound);
  });

  it('equals ignores ordering inside allowed.methods/origins/headers', () => {
    const eq = r2BucketCorsProvider.equals!;
    expect(
      eq(
        {
          bucketName: 'b',
          rules: [{ allowed: { methods: ['GET', 'HEAD'], origins: ['a', 'b'] } }],
        },
        {
          bucketName: 'b',
          rules: [{ allowed: { methods: ['HEAD', 'GET'], origins: ['b', 'a'] } }],
        },
      ),
    ).toBe(true);
  });
});

describe('r2BucketLifecycleProvider', () => {
  it('create translates rules to the lifecycle update body', async () => {
    const update = vi.fn().mockResolvedValue({});
    await r2BucketLifecycleProvider.create(
      makeCtx({ buckets: { lifecycle: { update, get: vi.fn() } } }),
      'logs/cold',
      {
        bucketName: 'cold-logs',
        rules: [
          {
            id: 'expire-30d',
            enabled: true,
            conditions: { prefix: '' },
            deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2592000 } },
          },
        ],
      },
    );
    expect(update).toHaveBeenCalledWith('cold-logs', {
      account_id: 'acc',
      rules: [
        {
          id: 'expire-30d',
          enabled: true,
          conditions: { prefix: '' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2592000 } },
        },
      ],
    });
  });

  it('delete clears every rule with an empty PUT body', async () => {
    const update = vi.fn().mockResolvedValue({});
    await r2BucketLifecycleProvider.delete(
      makeCtx({ buckets: { lifecycle: { update, get: vi.fn() } } }),
      'cold-logs',
    );
    expect(update).toHaveBeenCalledWith('cold-logs', { account_id: 'acc', rules: [] });
  });
});

describe('r2BucketEventNotificationProvider', () => {
  it('create PUTs rules under (bucketName, queueId)', async () => {
    const update = vi.fn().mockResolvedValue({});
    const desired = {
      bucketName: 'uploads',
      queueId: 'q-1',
      rules: [{ actions: ['PutObject' as const], prefix: 'incoming/' }],
    };
    const result = await r2BucketEventNotificationProvider.create(
      makeCtx({ buckets: { eventNotifications: { update, get: vi.fn(), delete: vi.fn() } } }),
      'data/uploads',
      desired,
    );
    expect(update).toHaveBeenCalledWith('uploads', 'q-1', {
      account_id: 'acc',
      rules: [{ actions: ['PutObject'], prefix: 'incoming/' }],
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'uploads::q-1' });
  });

  it('delete routes the bucketName::queueId nativeId back to two args', async () => {
    const del = vi.fn().mockResolvedValue({});
    await r2BucketEventNotificationProvider.delete(
      makeCtx({ buckets: { eventNotifications: { update: vi.fn(), get: vi.fn(), delete: del } } }),
      'uploads::q-1',
    );
    expect(del).toHaveBeenCalledWith('uploads', 'q-1', { account_id: 'acc' });
  });
});

describe('r2CustomDomainProvider', () => {
  it('create posts domain + zoneId + enabled to /domains/custom', async () => {
    const create = vi.fn().mockResolvedValue({ domain: 'cdn.example.com' });
    const result = await r2CustomDomainProvider.create(
      makeCtx({
        buckets: { domains: { custom: { create, get: vi.fn(), update: vi.fn(), delete: vi.fn() } } },
      }),
      'web/assets',
      {
        bucketName: 'assets',
        domain: 'cdn.example.com',
        zoneId: 'zone-1',
        enabled: true,
        minTLS: '1.2',
      },
    );
    expect(create).toHaveBeenCalledWith('assets', {
      account_id: 'acc',
      domain: 'cdn.example.com',
      enabled: true,
      zoneId: 'zone-1',
      minTLS: '1.2',
    });
    expect(result).toMatchObject({ kind: 'sync', nativeId: 'assets::cdn.example.com' });
  });

  it('update sends enabled + minTLS to the (bucket, domain) endpoint', async () => {
    const update = vi.fn().mockResolvedValue({ domain: 'cdn.example.com' });
    await r2CustomDomainProvider.update(
      makeCtx({
        buckets: { domains: { custom: { update, create: vi.fn(), get: vi.fn(), delete: vi.fn() } } },
      }),
      'assets::cdn.example.com',
      {
        bucketName: 'assets',
        domain: 'cdn.example.com',
        zoneId: 'zone-1',
        enabled: true,
      },
      {
        bucketName: 'assets',
        domain: 'cdn.example.com',
        zoneId: 'zone-1',
        enabled: false,
        minTLS: '1.3',
      },
    );
    expect(update).toHaveBeenCalledWith('assets', 'cdn.example.com', {
      account_id: 'acc',
      enabled: false,
      minTLS: '1.3',
    });
  });
});
