import { defineConfig } from 'vitest/config';

/**
 * Separate config for tests that need a real Kubernetes apiserver
 * (etcd + kube-apiserver, no kubelet) spun up via envtest. Kept off
 * the default `pnpm test` because the binary fetch is a one-time 50 MB
 * download and the suite is slower than the unit tests by an order of
 * magnitude.
 *
 * Run with: pnpm test:envtest
 *
 * The `globalSetup` brings up one apiserver per process, writes a
 * kubeconfig to a temp dir, and exposes its path via `KUBECONFIG`.
 * Tests share the apiserver; each test is responsible for namespacing
 * the resources it creates so they don't collide.
 */
export default defineConfig({
  esbuild: {
    target: 'es2022',
  },
  test: {
    include: ['tests/envtest/**/*.envtest.ts'],
    globalSetup: ['tests/envtest/_setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
