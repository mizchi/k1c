import { spawn } from 'node:child_process';
import process from 'node:process';
import type { LogsArgs, PortForwardArgs } from './args.ts';
export { runWranglerConfig, type WranglerConfigDeps } from './wrangler-config.ts';

/**
 * Translate a manifest <kind, name, namespace> tuple into the underlying Worker
 * script name. The mapping mirrors `lower.ts`: every k1c-managed Worker is
 * named `k1c--<ns>--<name>`. Resources whose `kind` does not lower to a Worker
 * are rejected — there is nothing to tail.
 */
function workerScriptName(
  resourceKind: string,
  name: string,
  namespace: string | undefined,
): string | { error: string } {
  const ns = namespace ?? 'default';
  const lowered = resourceKind.toLowerCase();
  switch (lowered) {
    case 'worker':
    case 'deployment':
    case 'rollout':
    case 'cronjob':
    case 'job':
    case 'statefulset':
      return `k1c--${ns}--${name}`;
    default:
      return {
        error: `cannot tail kind "${resourceKind}": only Worker-backed kinds (Deployment, Rollout, CronJob, Job, StatefulSet) are supported`,
      };
  }
}

export interface WranglerDeps {
  /** Override for tests. Defaults to spawning a real `wrangler` subprocess. */
  readonly run?: (cmd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => Promise<number>;
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
}

const defaultRun: NonNullable<WranglerDeps['run']> = (cmd, args, env) =>
  new Promise<number>((resolve) => {
    const child = spawn(cmd, [...args], { stdio: 'inherit', env });
    child.on('error', (e) => {
      process.stderr.write(`failed to spawn ${cmd}: ${(e as Error).message}\n`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });

export async function runLogs(args: LogsArgs, deps: WranglerDeps = {}): Promise<number> {
  const out = deps.out ?? ((m) => process.stdout.write(`${m}\n`));
  const err = deps.err ?? ((m) => process.stderr.write(`${m}\n`));
  const run = deps.run ?? defaultRun;

  const script = workerScriptName(args.resourceKind, args.name, args.namespace);
  if (typeof script !== 'string') {
    err(script.error);
    return 2;
  }

  const wranglerArgs: string[] = ['tail', script, '--format', args.format];
  if (args.status !== undefined) wranglerArgs.push('--status', args.status);
  // Wrangler tail itself has no `--limit`; we honor it by terminating the child
  // after N lines on the consumer side. For simplicity in v0.6 we forward the
  // raw flag and rely on wrangler ignoring unknown options or the user
  // post-processing — `--limit 0` (the default) is the safe no-op.
  if (args.limit > 0) wranglerArgs.push('--limit', String(args.limit));

  out(`(running: wrangler ${wranglerArgs.join(' ')})`);
  return run('wrangler', wranglerArgs, process.env);
}

export async function runPortForward(args: PortForwardArgs, deps: WranglerDeps = {}): Promise<number> {
  const out = deps.out ?? ((m) => process.stdout.write(`${m}\n`));
  const err = deps.err ?? ((m) => process.stderr.write(`${m}\n`));
  const run = deps.run ?? defaultRun;

  const script = workerScriptName(args.resourceKind, args.name, args.namespace);
  if (typeof script !== 'string') {
    err(script.error);
    return 2;
  }
  // Cloudflare has no first-class `port-forward` against a deployed Worker —
  // we emulate it via `wrangler dev --remote --name <script>` which spins up
  // a local proxy on the requested port. The script has to exist remotely
  // already (no auto-deploy). This is best-effort and only meaningful for
  // workers running in the user's own account.
  const wranglerArgs: string[] = [
    'dev',
    '--remote',
    '--name',
    script,
    '--port',
    String(args.localPort),
  ];
  out(
    `(running: wrangler ${wranglerArgs.join(' ')})\n(local proxy on http://127.0.0.1:${args.localPort})`,
  );
  return run('wrangler', wranglerArgs, process.env);
}
