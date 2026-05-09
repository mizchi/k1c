import { describe, expect, it } from 'vitest';
import { buildPath } from './watch.ts';

describe('buildPath', () => {
  it('puts core/v1 resources under /api', () => {
    expect(buildPath({ group: '', version: 'v1', plural: 'configmaps' })).toBe(
      '/api/v1/configmaps',
    );
  });

  it('puts grouped resources under /apis', () => {
    expect(buildPath({ group: 'apps', version: 'v1', plural: 'deployments' })).toBe(
      '/apis/apps/v1/deployments',
    );
  });

  it('inserts namespace segment when scoped to a single namespace', () => {
    expect(
      buildPath({ group: 'cloudflare.k1c.io', version: 'v1alpha1', plural: 'r2buckets' }, 'prod'),
    ).toBe('/apis/cloudflare.k1c.io/v1alpha1/namespaces/prod/r2buckets');
  });

  it('keeps cluster-wide path when namespace is undefined', () => {
    expect(
      buildPath({ group: 'cloudflare.k1c.io', version: 'v1alpha1', plural: 'r2buckets' }),
    ).toBe('/apis/cloudflare.k1c.io/v1alpha1/r2buckets');
  });

  it('handles core/v1 namespaced too', () => {
    expect(buildPath({ group: '', version: 'v1', plural: 'secrets' }, 'kube-system')).toBe(
      '/api/v1/namespaces/kube-system/secrets',
    );
  });
});
