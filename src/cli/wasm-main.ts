// Wasm-component entry point. A subset of the Node CLI: drops every
// command that needs Node-only primitives WASI 0.2 / StarlingMonkey
// doesn't (yet) expose:
//
//   * operator run    — @kubernetes/client-node (HTTP/2, raw streams)
//   * logs            — child_process spawn for `wrangler tail`
//   * port-forward    — same
//   * apply --watch   — fs.watch event source
//   * rollout         — pulls Cloudflare KV state lookups + main.ts
//                       helpers we'd duplicate; out of scope for v0
//   * config          — touches ~/.k1c/config.yaml; works in WASI but
//                       requires a preopened directory at link time,
//                       cleaner to skip
//
// What stays: apply, diff, get, describe, delete, wrangler-config, telemetry, explain,
// export-crds, version. These need only fetch + argv + env + read +
// stdio, all available in WASI 0.2 with StarlingMonkey.

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import Cloudflare from 'cloudflare';
import { parseArgs, USAGE, extractContext } from './args.ts';
import { runApply, runDelete, runDescribe, runDiff, runGet, type RunDeps } from './run.ts';
import { runWranglerConfig } from './wrangler-config.ts';
import { runTelemetry } from './telemetry.ts';
import { runExplain } from './explain.ts';
import { runExportCrds } from './export-crds.ts';
import { readManifestSource } from './manifest-source.ts';
import { resolveContext } from './contexts.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { ProviderContext } from '../providers/types.ts';
import pkg from '../../package.json' with { type: 'json' };

const VERSION = pkg.version;
const TARGET = 'wasm';

async function main(): Promise<number> {
  const { rest, context: contextFlag } = extractContext(process.argv.slice(2));
  const parsed = parseArgs(rest);

  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`k1c ${VERSION} (${TARGET})\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`k1c: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.kind === 'explain') {
    return runExplain({ kind: parsed.resourceKind, recursive: parsed.recursive });
  }
  if (parsed.kind === 'export-crds') {
    return runExportCrds(parsed);
  }
  if (parsed.kind === 'wrangler-config') {
    return runWranglerConfig(parsed, {
      readManifest: readManifestSource,
      readFile: async (path: string) => readFile(path),
      out: (msg: string) => process.stdout.write(`${msg}\n`),
      err: (msg: string) => process.stderr.write(`${msg}\n`),
    });
  }
  const validateOnly = parsed.kind === 'apply' && parsed.validateOnly;

  // Commands not supported by the wasm target — see the file header.
  if (
    parsed.kind === 'operator' ||
    parsed.kind === 'logs' ||
    parsed.kind === 'port-forward' ||
    parsed.kind === 'rollout' ||
    parsed.kind === 'config' ||
    (parsed.kind === 'apply' && parsed.watch)
  ) {
    const what = parsed.kind === 'apply' ? 'apply --watch' : parsed.kind;
    process.stderr.write(
      `k1c: \`${what}\` is not available in the wasm build. Use the Node CLI.\n`,
    );
    return 2;
  }

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

  const quiet = parsed.kind === 'apply' && parsed.quiet;
  const deps: RunDeps = {
    registry: createDefaultRegistry(),
    providerCtx: ctx,
    readManifest: readManifestSource,
    out: quiet ? () => {} : (msg: string) => process.stdout.write(`${msg}\n`),
    err: (msg: string) => process.stderr.write(`${msg}\n`),
  };

  if (parsed.kind === 'apply') return runApply(parsed, deps);
  if (parsed.kind === 'diff') return runDiff(parsed, deps);
  if (parsed.kind === 'get') return runGet(parsed, deps);
  if (parsed.kind === 'describe') return runDescribe(parsed, deps);
  if (parsed.kind === 'delete') return runDelete(parsed, deps);
  if (parsed.kind === 'telemetry')
    return runTelemetry(parsed, { accountId: accountId!, apiToken: apiToken! });
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`k1c: unhandled: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
