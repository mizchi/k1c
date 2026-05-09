#!/usr/bin/env node
import { readFile, watch } from 'node:fs/promises';
import process from 'node:process';
import { resolve as resolvePath } from 'node:path';
import Cloudflare from 'cloudflare';
import {
  parseArgs,
  USAGE,
  extractContext,
  type ApplyArgs,
  type ConfigArgs,
  type RolloutArgs,
} from './args.ts';
import { runApply, runDelete, runDescribe, runDiff, runGet, type RunDeps } from './run.ts';
import { runLogs, runPortForward } from './wrangler.ts';
import { runTelemetry } from './telemetry.ts';
import { runExplain } from './explain.ts';
import { runExportCrds } from './export-crds.ts';
import { runOperator } from '../operator/reconcile.ts';
import { readManifestSource } from './manifest-source.ts';
import { resolveContext, loadContexts, saveContexts, configPath, type K1cContext } from './contexts.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { ProviderContext } from '../providers/types.ts';
import { runRolloutCommand } from '../canary/rollout-command.ts';
import type { RolloutStateClient } from '../canary/runtime.ts';
import pkg from '../../package.json' with { type: 'json' };

const VERSION = pkg.version;

async function main(): Promise<number> {
  const { rest, context: contextFlag } = extractContext(process.argv.slice(2));
  const parsed = parseArgs(rest);

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
  // `explain` works without API credentials — it only inspects local schemas.
  if (parsed.kind === 'explain') {
    return runExplain({ kind: parsed.resourceKind, recursive: parsed.recursive });
  }
  // `export-crds` is also offline.
  if (parsed.kind === 'export-crds') {
    return runExportCrds(parsed);
  }
  // `apply --validate-only` is also offline (parse + lower only).
  const validateOnly = parsed.kind === 'apply' && parsed.validateOnly;

  // `config` reads / writes ~/.k1c/config.yaml directly; no API call.
  if (parsed.kind === 'config') return runConfig(parsed);

  let accountId: string | undefined;
  let apiToken: string | undefined;
  let zoneIdFromCtx: string | undefined;
  if (!validateOnly) {
    const resolved = await resolveContext({
      ...(contextFlag !== undefined ? { cliName: contextFlag } : {}),
    });
    if ('error' in resolved) {
      process.stderr.write(`${resolved.error}\n`);
      return 2;
    }
    accountId = resolved.accountId;
    apiToken = resolved.apiToken;
    zoneIdFromCtx = resolved.zoneId;
    if (resolved.source !== 'legacy' && resolved.name !== undefined) {
      process.stderr.write(`(using context "${resolved.name}" from ${resolved.source})\n`);
    }
  }

  // The Cloudflare client is only used by paths that talk to the API; under
  // --validate-only we still construct it (with a dummy token if needed) so
  // `RunDeps.providerCtx` stays valid, but no provider methods will be called.
  const cloudflare = new Cloudflare({ apiToken: apiToken ?? 'placeholder-validate-only' });
  const zoneId = zoneIdFromCtx ?? process.env['K1C_ZONE_ID'];
  const ctx: ProviderContext = {
    cloudflare,
    accountId: accountId ?? 'placeholder-validate-only',
    ...(zoneId !== undefined && zoneId.length > 0 ? { zoneId } : {}),
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
    readFile: async (path: string) => readFile(path),
  };

  // Standard out / error sinks. `--quiet` swaps stdout for a no-op so the
  // command still exits with the right status but does not print per-op
  // progress; errors continue to flow through stderr unchanged.
  const quiet = parsed.kind === 'apply' && parsed.quiet;
  const deps = {
    registry: createDefaultRegistry(),
    providerCtx: ctx,
    readManifest: readManifestSource,
    out: quiet ? () => {} : (msg: string) => process.stdout.write(`${msg}\n`),
    err: (msg: string) => process.stderr.write(`${msg}\n`),
  };

  if (parsed.kind === 'apply') {
    return parsed.watch ? runApplyWatch(parsed, deps) : runApply(parsed, deps);
  }
  if (parsed.kind === 'diff') return runDiff(parsed, deps);
  if (parsed.kind === 'get') return runGet(parsed, deps);
  if (parsed.kind === 'describe') return runDescribe(parsed, deps);
  if (parsed.kind === 'delete') return runDelete(parsed, deps);
  if (parsed.kind === 'rollout') return runRollout(parsed, cloudflare, accountId!);
  if (parsed.kind === 'logs') return runLogs(parsed);
  if (parsed.kind === 'port-forward') return runPortForward(parsed);
  if (parsed.kind === 'telemetry')
    return runTelemetry(parsed, { accountId: accountId!, apiToken: apiToken! });
  if (parsed.kind === 'operator') {
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    process.on('SIGTERM', () => ac.abort());
    await runOperator(
      {
        accountId: accountId!,
        apiToken: apiToken!,
        ...(zoneId !== undefined ? { zoneId } : {}),
        ...(parsed.namespace !== undefined ? { namespace: parsed.namespace } : {}),
        intervalMs: parsed.intervalSec * 1000,
        watch: parsed.watch,
        metricsAddr: parsed.metricsAddr,
        leaderElection: parsed.leaderElection,
        ...(parsed.leaseName !== undefined ? { leaseName: parsed.leaseName } : {}),
        ...(parsed.leaseNamespace !== undefined ? { leaseNamespace: parsed.leaseNamespace } : {}),
        logFormat: parsed.logFormat,
      },
      ac.signal,
    );
    return 0;
  }
  return 2;
}

async function runApplyWatch(args: ApplyArgs, deps: RunDeps): Promise<number> {
  if (args.file === '-') {
    process.stderr.write('--watch is not compatible with stdin (-) input\n');
    return 2;
  }
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

async function runConfig(args: ConfigArgs): Promise<number> {
  const file = await loadContexts();
  if (args.subCommand === 'list') {
    const entries = Object.entries(file.contexts);
    if (entries.length === 0) {
      process.stdout.write(`(no contexts in ${configPath()})\n`);
      return 0;
    }
    for (const [name, ctx] of entries) {
      const star = file.currentContext === name ? '* ' : '  ';
      process.stdout.write(
        `${star}${name}  account=${ctx.accountId}${ctx.zoneId ? ` zone=${ctx.zoneId}` : ''}${ctx.apiTokenEnv ? ` token-env=${ctx.apiTokenEnv}` : ''}\n`,
      );
    }
    return 0;
  }
  if (args.subCommand === 'current-context') {
    process.stdout.write(`${file.currentContext ?? '(none)'}\n`);
    return 0;
  }
  if (args.subCommand === 'use-context') {
    if (!file.contexts[args.contextName!]) {
      process.stderr.write(`context "${args.contextName}" is not defined\n`);
      return 2;
    }
    await saveContexts({ ...file, currentContext: args.contextName });
    process.stdout.write(`switched to context "${args.contextName}"\n`);
    return 0;
  }
  if (args.subCommand === 'set-context') {
    const next: K1cContext = {
      accountId: args.accountId!,
      ...(args.zoneId !== undefined ? { zoneId: args.zoneId } : {}),
      ...(args.apiTokenEnv !== undefined ? { apiTokenEnv: args.apiTokenEnv } : {}),
    };
    const contexts = { ...file.contexts, [args.contextName!]: next };
    await saveContexts({ ...file, contexts });
    process.stdout.write(`set context "${args.contextName}"\n`);
    return 0;
  }
  if (args.subCommand === 'delete-context') {
    if (!file.contexts[args.contextName!]) {
      process.stderr.write(`context "${args.contextName}" is not defined\n`);
      return 2;
    }
    const contexts = { ...file.contexts };
    delete (contexts as Record<string, unknown>)[args.contextName!];
    const nextCurrent =
      file.currentContext === args.contextName ? undefined : file.currentContext;
    await saveContexts({
      contexts,
      ...(nextCurrent !== undefined ? { currentContext: nextCurrent } : {}),
    });
    process.stdout.write(`deleted context "${args.contextName}"\n`);
    return 0;
  }
  return 2;
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
