import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContext, loadContexts, saveContexts } from './contexts.ts';

let workdir: string;
let originalConfig: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'k1c-ctx-'));
  originalConfig = process.env['K1C_CONFIG'];
  process.env['K1C_CONFIG'] = join(workdir, 'config.yaml');
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env['K1C_CONFIG'];
  else process.env['K1C_CONFIG'] = originalConfig;
});

describe('resolveContext', () => {
  it('falls back to legacy K1C_ACCOUNT_ID + CLOUDFLARE_API_TOKEN env when no config exists', async () => {
    const result = await resolveContext({
      env: { K1C_ACCOUNT_ID: 'acc-legacy', CLOUDFLARE_API_TOKEN: 'tok-legacy' },
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.accountId).toBe('acc-legacy');
    expect(result.apiToken).toBe('tok-legacy');
    expect(result.source).toBe('legacy');
  });

  it('reads currentContext from the file when nothing on the CLI / env points at one', async () => {
    await writeFile(
      join(workdir, 'config.yaml'),
      `currentContext: prod\ncontexts:\n  prod:\n    accountId: acc-prod\n    zoneId: zone-prod\n    apiTokenEnv: PROD_TOKEN\n`,
    );
    const result = await resolveContext({
      env: { PROD_TOKEN: 'tok-prod' },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.accountId).toBe('acc-prod');
    expect(result.zoneId).toBe('zone-prod');
    expect(result.apiToken).toBe('tok-prod');
    expect(result.source).toBe('file');
    expect(result.name).toBe('prod');
  });

  it('--context flag overrides currentContext', async () => {
    await writeFile(
      join(workdir, 'config.yaml'),
      `currentContext: prod\ncontexts:\n  prod:\n    accountId: acc-prod\n    apiTokenEnv: PROD_TOKEN\n  staging:\n    accountId: acc-staging\n    apiTokenEnv: STAGING_TOKEN\n`,
    );
    const result = await resolveContext({
      cliName: 'staging',
      env: { STAGING_TOKEN: 'tok-staging' },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.accountId).toBe('acc-staging');
    expect(result.source).toBe('flag');
    expect(result.name).toBe('staging');
  });

  it('K1C_CONTEXT env overrides currentContext but not --context flag', async () => {
    await writeFile(
      join(workdir, 'config.yaml'),
      `currentContext: prod\ncontexts:\n  prod:\n    accountId: acc-prod\n    apiTokenEnv: PROD_TOKEN\n  staging:\n    accountId: acc-staging\n    apiTokenEnv: STAGING_TOKEN\n`,
    );
    const result = await resolveContext({
      env: { K1C_CONTEXT: 'staging', STAGING_TOKEN: 'tok-staging' },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.name).toBe('staging');
    expect(result.source).toBe('env');
  });

  it('returns an error when --context names a non-existent context', async () => {
    const result = await resolveContext({ cliName: 'ghost', env: {} });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/ghost/);
    }
  });

  it('returns an error when the API token env is not set', async () => {
    await writeFile(
      join(workdir, 'config.yaml'),
      `currentContext: prod\ncontexts:\n  prod:\n    accountId: acc\n    apiTokenEnv: MISSING_TOKEN\n`,
    );
    const result = await resolveContext({ env: {} });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/MISSING_TOKEN/);
  });
});

describe('loadContexts / saveContexts', () => {
  it('round-trips a context file', async () => {
    await saveContexts({
      currentContext: 'prod',
      contexts: { prod: { accountId: 'a', zoneId: 'z', apiTokenEnv: 'T' } },
    });
    const loaded = await loadContexts();
    expect(loaded.currentContext).toBe('prod');
    expect(loaded.contexts['prod']).toEqual({
      accountId: 'a',
      zoneId: 'z',
      apiTokenEnv: 'T',
    });
  });
});
