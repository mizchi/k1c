import { defineConfig } from 'vitest/config';

/**
 * Separate config for e2e tests that hit a real Cloudflare account. The default
 * `vitest.config.ts` only includes `src/**` to keep `pnpm test` fast and
 * offline; this config opts in `tests/e2e/**` and bumps the timeout for live
 * network round-trips.
 *
 * Run with: K1C_E2E=1 K1C_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm test:e2e
 */
export default defineConfig({
  esbuild: {
    target: 'es2022',
  },
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
