import { readFile } from 'node:fs/promises';
import process from 'node:process';
import Cloudflare from 'cloudflare';
import { parseArgs, USAGE, type RolloutArgs } from './args.ts';
import { runApply, runDiff } from './run.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { ProviderContext } from '../providers/types.ts';
import { runRolloutCommand } from '../canary/rollout-command.ts';
import type { RolloutStateClient } from '../canary/runtime.ts';

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`k1c: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  const accountId = process.env['K1C_ACCOUNT_ID'];
  const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
  if (!accountId) {
    process.stderr.write('K1C_ACCOUNT_ID is not set\n');
    return 2;
  }
  if (!apiToken) {
    process.stderr.write('CLOUDFLARE_API_TOKEN is not set\n');
    return 2;
  }

  const cloudflare = new Cloudflare({ apiToken });
  const ctx: ProviderContext = {
    cloudflare,
    accountId,
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
    readFile: async (path: string) => readFile(path),
  };

  const deps = {
    registry: createDefaultRegistry(),
    providerCtx: ctx,
    readManifest: async (path: string) => {
      const buf = await readFile(path);
      return buf.toString('utf-8');
    },
    out: (msg: string) => process.stdout.write(`${msg}\n`),
    err: (msg: string) => process.stderr.write(`${msg}\n`),
  };

  if (parsed.kind === 'apply') return runApply(parsed, deps);
  if (parsed.kind === 'diff') return runDiff(parsed, deps);
  if (parsed.kind === 'rollout') return runRollout(parsed, cloudflare, accountId);
  return 2;
}

async function runRollout(
  args: RolloutArgs,
  cloudflare: Cloudflare,
  accountId: string,
): Promise<number> {
  const stateKvId = await findStateKvId(cloudflare, accountId, args.dispatch);
  if (stateKvId === null) {
    process.stderr.write(
      `no rollout-state KV found for dispatch namespace "${args.dispatch}"; run \`k1c apply\` first\n`,
    );
    return 1;
  }
  const state: RolloutStateClient = {
    async read(key) {
      try {
        const resp = await cloudflare.kv.namespaces.values.get(stateKvId, key, {
          account_id: accountId,
        });
        return await resp.text();
      } catch (e) {
        if (isApi404(e)) return null;
        throw e;
      }
    },
    async write(key, value) {
      await cloudflare.kv.namespaces.values.update(stateKvId, key, {
        account_id: accountId,
        value,
      });
    },
  };
  return runRolloutCommand(
    { subCommand: args.subCommand, target: args.target },
    {
      state,
      out: (msg: string) => process.stdout.write(`${msg}\n`),
      err: (msg: string) => process.stderr.write(`${msg}\n`),
    },
  );
}

async function findStateKvId(
  cf: Cloudflare,
  accountId: string,
  dispatch: string,
): Promise<string | null> {
  const expected = `k1c/rollout-state/${dispatch}`;
  for await (const ns of cf.kv.namespaces.list({ account_id: accountId })) {
    if (ns.title === expected) return ns.id;
  }
  return null;
}

function isApi404(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  return (err as { status?: number }).status === 404;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
