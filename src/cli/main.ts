#!/usr/bin/env node
import { readFile, watch } from 'node:fs/promises';
import process from 'node:process';
import { resolve as resolvePath } from 'node:path';
import Cloudflare from 'cloudflare';
import { parseArgs, USAGE, type ApplyArgs, type RolloutArgs } from './args.ts';
import { runApply, runDelete, runDescribe, runDiff, runGet, type RunDeps } from './run.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { ProviderContext } from '../providers/types.ts';
import { runRolloutCommand } from '../canary/rollout-command.ts';
import type { RolloutStateClient } from '../canary/runtime.ts';
import pkg from '../../package.json' with { type: 'json' };

const VERSION = pkg.version;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`k1c ${VERSION}\n`);
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

  if (parsed.kind === 'apply') {
    return parsed.watch ? runApplyWatch(parsed, deps) : runApply(parsed, deps);
  }
  if (parsed.kind === 'diff') return runDiff(parsed, deps);
  if (parsed.kind === 'get') return runGet(parsed, deps);
  if (parsed.kind === 'describe') return runDescribe(parsed, deps);
  if (parsed.kind === 'delete') return runDelete(parsed, deps);
  if (parsed.kind === 'rollout') return runRollout(parsed, cloudflare, accountId);
  return 2;
}

async function runApplyWatch(args: ApplyArgs, deps: RunDeps): Promise<number> {
  const filePath = resolvePath(args.file);
  process.stdout.write(`(watching ${filePath} — initial apply)\n`);
  await runApply(args, deps);
  process.stdout.write(`\n(watching for changes; Ctrl-C to exit)\n`);
  // Coalesce bursts of fs events; editors often emit multiple events per save.
  let pending: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const trigger = () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      inFlight = inFlight.then(async () => {
        process.stdout.write(`\n(change detected → re-applying)\n`);
        try {
          await runApply(args, deps);
        } catch (e) {
          process.stderr.write(
            `apply during watch failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      });
    }, 200);
  };
  try {
    for await (const _event of watch(filePath)) {
      trigger();
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      process.stderr.write(`manifest no longer readable: ${filePath}\n`);
      return 1;
    }
    throw e;
  }
  return 0;
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
    process.stderr.write(`fatal: ${formatError(err)}\n`);
    process.exit(1);
  },
);

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  // Provider errors are plain objects shaped as { code, recoverable, message, ... };
  // formatting them through `String(err)` yields "[object Object]" and loses the
  // useful fields. Render the structured form instead.
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.message === 'string') {
      return typeof e.code === 'string' ? `[${e.code}] ${e.message}` : e.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
