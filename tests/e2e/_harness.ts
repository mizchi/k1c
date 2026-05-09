import { randomBytes } from 'node:crypto';
import Cloudflare from 'cloudflare';
import type { ProviderContext } from '../../src/providers/types.ts';

/**
 * Returns true when the e2e environment is fully wired (live Cloudflare token,
 * account id, and the explicit `K1C_E2E=1` opt-in). Tests use this as the
 * predicate to `it.skipIf` so a developer who runs `pnpm test:e2e` without the
 * env vars set sees a clean "skipped" report rather than a misleading failure.
 */
export function e2eEnabled(): boolean {
  return (
    process.env['K1C_E2E'] === '1' &&
    typeof process.env['K1C_ACCOUNT_ID'] === 'string' &&
    process.env['K1C_ACCOUNT_ID'].length > 0 &&
    typeof process.env['CLOUDFLARE_API_TOKEN'] === 'string' &&
    process.env['CLOUDFLARE_API_TOKEN'].length > 0
  );
}

/**
 * Short, lowercase, alphanumeric run id used to suffix every resource a test
 * creates. Resources with this suffix are assumed to be safe to delete on
 * teardown. Generated once per process so a `--bail`-style early exit still
 * leaves tagged resources discoverable.
 */
export const RUN_ID = randomBytes(4).toString('hex');

export interface E2EContext {
  readonly cloudflare: Cloudflare;
  readonly accountId: string;
  readonly zoneId?: string;
  readonly providerCtx: ProviderContext;
}

export function buildE2EContext(): E2EContext {
  const accountId = process.env['K1C_ACCOUNT_ID']!;
  const apiToken = process.env['CLOUDFLARE_API_TOKEN']!;
  const zoneId = process.env['K1C_ZONE_ID'];
  const cloudflare = new Cloudflare({ apiToken });
  const providerCtx: ProviderContext = {
    cloudflare,
    accountId,
    ...(zoneId !== undefined && zoneId.length > 0 ? { zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c-e2e',
    signal: new AbortController().signal,
  };
  return { cloudflare, accountId, ...(zoneId ? { zoneId } : {}), providerCtx };
}

/**
 * Best-effort cleanup that swallows errors so an exception in one teardown step
 * does not mask the real failure of an earlier assertion. Each test should still
 * make its own attempt to delete what it created — this is the safety net.
 */
export async function safeCleanup(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`[e2e cleanup ignored] ${(err as Error).message ?? String(err)}\n`);
  }
}

/** Resource name suffix shared by every resource a test creates. */
export function e2eName(prefix: string): string {
  return `${prefix}-e2e-${RUN_ID}`;
}
