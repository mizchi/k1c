export type OutputFormat = 'text' | 'json';

export interface ApplyArgs {
  readonly kind: 'apply';
  readonly file: string;
  readonly dryRun: boolean;
  readonly watch: boolean;
  readonly quiet: boolean;
  /**
   * Schema-level validation only — parse + lower the manifest, report any
   * errors, then exit. No Cloudflare round-trip, so the command runs offline
   * (CI hooks, pre-commit). Mutually exclusive with --watch / --dry-run.
   */
  readonly validateOnly: boolean;
}

export interface DiffArgs {
  readonly kind: 'diff';
  readonly file: string;
  readonly output: OutputFormat;
  /** Include per-field +/- diffs under each `update` op. */
  readonly verbose: boolean;
  /** Force color on/off; auto-detect when undefined. */
  readonly color?: 'always' | 'never';
}

export interface RolloutArgs {
  readonly kind: 'rollout';
  readonly subCommand: 'status' | 'promote' | 'abort';
  readonly target: string;
  readonly dispatch: string;
}

export interface GetArgs {
  readonly kind: 'get';
  readonly resourceKind: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly output: OutputFormat;
}

export interface DescribeArgs {
  readonly kind: 'describe';
  readonly resourceKind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly output: OutputFormat;
}

export interface VersionArgs {
  readonly kind: 'version';
}

export interface DeleteArgs {
  readonly kind: 'delete';
  readonly file: string;
  readonly cascade: boolean;
}

export interface LogsArgs {
  readonly kind: 'logs';
  /** Resource kind. Currently only `Worker` (or its k8s analogues) is supported. */
  readonly resourceKind: string;
  readonly name: string;
  readonly namespace?: string;
  /** `wrangler tail` --format flag. */
  readonly format: 'json' | 'pretty';
  /** Pass-through filter on log status (`error` / `ok` / etc.). */
  readonly status?: string;
  /** Stop tailing after N lines (0 = stream forever). */
  readonly limit: number;
}

export interface PortForwardArgs {
  readonly kind: 'port-forward';
  readonly resourceKind: string;
  readonly name: string;
  readonly namespace?: string;
  /** Local port to bind. */
  readonly localPort: number;
}

export interface TelemetryArgs {
  readonly kind: 'telemetry';
  /** Currently only `workers` is supported. */
  readonly subject: 'workers';
  readonly resourceKind: string;
  readonly name: string;
  readonly namespace?: string;
  /** Lookback window: `5m`, `1h`, `24h`, `7d`. */
  readonly since: string;
  readonly output: OutputFormat;
}

export interface ExplainArgs {
  readonly kind: 'explain';
  readonly resourceKind: string;
  readonly recursive: boolean;
}

export interface ExportCrdsArgs {
  readonly kind: 'export-crds';
  readonly includeStandard: boolean;
}

export interface ConfigArgs {
  readonly kind: 'config';
  readonly subCommand:
    | 'list'
    | 'use-context'
    | 'set-context'
    | 'current-context'
    | 'delete-context';
  readonly contextName?: string;
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly apiTokenEnv?: string;
}

export interface HelpArgs {
  readonly kind: 'help';
}

export interface ErrorArgs {
  readonly kind: 'error';
  readonly message: string;
}

export type ParsedArgs =
  | ApplyArgs
  | DiffArgs
  | RolloutArgs
  | GetArgs
  | DescribeArgs
  | DeleteArgs
  | LogsArgs
  | PortForwardArgs
  | TelemetryArgs
  | ExplainArgs
  | ConfigArgs
  | ExportCrdsArgs
  | VersionArgs
  | HelpArgs
  | ErrorArgs;

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) return { kind: 'help' };
  const first = argv[0]!;
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-V' || first === 'version') {
    return { kind: 'version' };
  }
  if (first === 'apply') return parseApply(argv.slice(1));
  if (first === 'diff') return parseDiff(argv.slice(1));
  if (first === 'rollout') return parseRollout(argv.slice(1));
  if (first === 'get') return parseGet(argv.slice(1));
  if (first === 'describe') return parseDescribe(argv.slice(1));
  if (first === 'delete') return parseDelete(argv.slice(1));
  if (first === 'logs') return parseLogs(argv.slice(1));
  if (first === 'port-forward') return parsePortForward(argv.slice(1));
  if (first === 'telemetry') return parseTelemetry(argv.slice(1));
  if (first === 'explain') return parseExplain(argv.slice(1));
  if (first === 'config') return parseConfig(argv.slice(1));
  if (first === 'export-crds') return parseExportCrds(argv.slice(1));
  return { kind: 'error', message: `unknown command: ${first}` };
}

function parseExportCrds(rest: ReadonlyArray<string>): ParsedArgs {
  let includeStandard = false;
  for (const arg of rest) {
    if (arg === '--include-standard') {
      includeStandard = true;
      continue;
    }
    return { kind: 'error', message: `unknown flag for export-crds: ${arg}` };
  }
  return { kind: 'export-crds', includeStandard };
}

function parseConfig(rest: ReadonlyArray<string>): ParsedArgs {
  const sub = rest[0];
  if (
    sub !== 'list' &&
    sub !== 'use-context' &&
    sub !== 'set-context' &&
    sub !== 'current-context' &&
    sub !== 'delete-context'
  ) {
    return {
      kind: 'error',
      message:
        'config requires a subcommand: list | use-context | set-context | current-context | delete-context',
    };
  }
  let contextName: string | undefined;
  let accountId: string | undefined;
  let zoneId: string | undefined;
  let apiTokenEnv: string | undefined;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--account' || arg === '--account-id') {
      accountId = rest[i + 1];
      if (accountId === undefined) return { kind: 'error', message: `${arg} requires a value` };
      i += 1;
      continue;
    }
    if (arg === '--zone' || arg === '--zone-id') {
      zoneId = rest[i + 1];
      if (zoneId === undefined) return { kind: 'error', message: `${arg} requires a value` };
      i += 1;
      continue;
    }
    if (arg === '--token-env') {
      apiTokenEnv = rest[i + 1];
      if (apiTokenEnv === undefined) return { kind: 'error', message: `${arg} requires a value` };
      i += 1;
      continue;
    }
    if (!arg.startsWith('-') && contextName === undefined) {
      contextName = arg;
      continue;
    }
    return { kind: 'error', message: `unknown flag for config: ${arg}` };
  }
  if (
    (sub === 'use-context' || sub === 'set-context' || sub === 'delete-context') &&
    contextName === undefined
  ) {
    return { kind: 'error', message: `config ${sub} requires a context name` };
  }
  if (sub === 'set-context' && accountId === undefined) {
    return { kind: 'error', message: 'config set-context requires --account <id>' };
  }
  return {
    kind: 'config',
    subCommand: sub,
    ...(contextName !== undefined ? { contextName } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(zoneId !== undefined ? { zoneId } : {}),
    ...(apiTokenEnv !== undefined ? { apiTokenEnv } : {}),
  };
}

/**
 * Pre-extract the `--context <name>` flag from argv so subcommand parsers
 * do not all need to learn about it. Returns the rest of argv minus the
 * flag, plus the context name when present.
 */
export function extractContext(
  argv: ReadonlyArray<string>,
): { rest: string[]; context: string | undefined } {
  const rest: string[] = [];
  let context: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--context') {
      context = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(a);
  }
  return { rest, context };
}

function parseExplain(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0] ?? 'list';
  let recursive = false;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--recursive' || arg === '-r') {
      recursive = true;
      continue;
    }
    return { kind: 'error', message: `unknown flag for explain: ${arg}` };
  }
  return { kind: 'explain', resourceKind, recursive };
}

function parseTelemetry(rest: ReadonlyArray<string>): ParsedArgs {
  const subject = rest[0];
  if (subject !== 'workers') {
    return {
      kind: 'error',
      message: `telemetry requires a subject: workers (got "${subject ?? '(missing)'}")`,
    };
  }
  const resourceKind = rest[1];
  const name = rest[2];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'telemetry workers requires a resource kind' };
  }
  if (name === undefined || name.startsWith('-')) {
    return { kind: 'error', message: 'telemetry workers requires a resource name' };
  }
  let namespace: string | undefined;
  let since = '1h';
  let output: OutputFormat = 'text';
  for (let i = 3; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    if (arg === '--since') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: '--since requires a value' };
      if (!/^\d+[smhd]$/.test(value)) {
        return {
          kind: 'error',
          message: `--since must look like 5m / 1h / 24h / 7d (got "${value}")`,
        };
      }
      since = value;
      i += 1;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const parsed = parseOutput(rest[i + 1]);
      if (typeof parsed === 'object') return { kind: 'error', message: parsed.error };
      output = parsed;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for telemetry: ${arg}` };
  }
  return {
    kind: 'telemetry',
    subject: 'workers',
    resourceKind,
    name,
    since,
    output,
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

function parseLogs(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0];
  const name = rest[1];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'logs requires a resource kind (e.g. Worker, Deployment)' };
  }
  if (name === undefined || name.startsWith('-')) {
    return { kind: 'error', message: 'logs requires a resource name' };
  }
  let namespace: string | undefined;
  let format: 'json' | 'pretty' = 'pretty';
  let status: string | undefined;
  let limit = 0;
  for (let i = 2; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    if (arg === '--format') {
      const value = rest[i + 1];
      if (value !== 'json' && value !== 'pretty') {
        return { kind: 'error', message: `--format must be one of: json, pretty (got "${value}")` };
      }
      format = value;
      i += 1;
      continue;
    }
    if (arg === '--status') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: '--status requires a value' };
      status = value;
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const value = rest[i + 1];
      const parsed = value !== undefined ? Number.parseInt(value, 10) : NaN;
      if (Number.isNaN(parsed) || parsed < 0) {
        return { kind: 'error', message: '--limit requires a non-negative integer' };
      }
      limit = parsed;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for logs: ${arg}` };
  }
  return {
    kind: 'logs',
    resourceKind,
    name,
    format,
    limit,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function parsePortForward(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0];
  const name = rest[1];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'port-forward requires a resource kind' };
  }
  if (name === undefined || name.startsWith('-')) {
    return { kind: 'error', message: 'port-forward requires a resource name' };
  }
  let namespace: string | undefined;
  let localPort = 8787;
  for (let i = 2; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      const value = rest[i + 1];
      const parsed = value !== undefined ? Number.parseInt(value, 10) : NaN;
      if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        return { kind: 'error', message: '--port requires an integer in 1-65535' };
      }
      localPort = parsed;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for port-forward: ${arg}` };
  }
  return {
    kind: 'port-forward',
    resourceKind,
    name,
    localPort,
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

function parseOutput(value: string | undefined): OutputFormat | { error: string } {
  if (value === undefined) return { error: '--output requires a value (text|json)' };
  if (value === 'text' || value === 'json') return value;
  return { error: `--output must be one of: text, json (got "${value}")` };
}

function parseGet(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'get requires a resource kind (e.g. Worker, R2Bucket)' };
  }
  let name: string | undefined;
  let namespace: string | undefined;
  let output: OutputFormat = 'text';
  let i = 1;
  if (rest[1] !== undefined && !rest[1].startsWith('-')) {
    name = rest[1];
    i = 2;
  }
  for (; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const parsed = parseOutput(rest[i + 1]);
      if (typeof parsed === 'object') return { kind: 'error', message: parsed.error };
      output = parsed;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for get: ${arg}` };
  }
  return {
    kind: 'get',
    resourceKind,
    output,
    ...(name !== undefined ? { name } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

function parseDescribe(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'describe requires a resource kind' };
  }
  const name = rest[1];
  if (name === undefined || name.startsWith('-')) {
    return { kind: 'error', message: 'describe requires a resource name' };
  }
  let namespace: string | undefined;
  let output: OutputFormat = 'text';
  for (let i = 2; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const parsed = parseOutput(rest[i + 1]);
      if (typeof parsed === 'object') return { kind: 'error', message: parsed.error };
      output = parsed;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for describe: ${arg}` };
  }
  return {
    kind: 'describe',
    resourceKind,
    name,
    output,
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

function parseDelete(rest: ReadonlyArray<string>): ParsedArgs {
  let file: string | undefined;
  let cascade = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-f' || arg === '--file') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      file = value;
      i += 1;
      continue;
    }
    if (arg === '--cascade') {
      cascade = true;
      continue;
    }
    return { kind: 'error', message: `unknown flag for delete: ${arg}` };
  }
  if (file === undefined) return { kind: 'error', message: 'delete requires -f / --file' };
  return { kind: 'delete', file, cascade };
}

function parseRollout(rest: ReadonlyArray<string>): ParsedArgs {
  const sub = rest[0];
  if (sub === undefined) {
    return { kind: 'error', message: 'rollout requires a subcommand: status | promote | abort' };
  }
  if (sub !== 'status' && sub !== 'promote' && sub !== 'abort') {
    return { kind: 'error', message: `unknown rollout subcommand: ${sub}` };
  }
  const target = rest[1];
  if (target === undefined || target.startsWith('-')) {
    return { kind: 'error', message: `rollout ${sub} requires a target <namespace>/<name>` };
  }
  let dispatch: string | undefined;
  for (let i = 2; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--dispatch') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: '--dispatch requires a value' };
      dispatch = value;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for rollout: ${arg}` };
  }
  if (dispatch === undefined) {
    return { kind: 'error', message: `rollout ${sub} requires --dispatch <name>` };
  }
  return { kind: 'rollout', subCommand: sub, target, dispatch };
}

function parseApply(rest: ReadonlyArray<string>): ParsedArgs {
  let file: string | undefined;
  let dryRun = false;
  let watch = false;
  let quiet = false;
  let validateOnly = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-f' || arg === '--file') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      file = value;
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--watch' || arg === '-w') {
      watch = true;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      quiet = true;
      continue;
    }
    if (arg === '--validate-only') {
      validateOnly = true;
      continue;
    }
    return { kind: 'error', message: `unknown flag for apply: ${arg}` };
  }
  if (file === undefined) {
    return { kind: 'error', message: 'apply requires -f / --file' };
  }
  if (dryRun && watch) {
    return { kind: 'error', message: '--dry-run and --watch are mutually exclusive' };
  }
  if (validateOnly && (watch || dryRun)) {
    return {
      kind: 'error',
      message: '--validate-only is mutually exclusive with --watch / --dry-run',
    };
  }
  return { kind: 'apply', file, dryRun, watch, quiet, validateOnly };
}

function parseDiff(rest: ReadonlyArray<string>): ParsedArgs {
  let file: string | undefined;
  let output: OutputFormat = 'text';
  let verbose = false;
  let color: 'always' | 'never' | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-f' || arg === '--file') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      file = value;
      i += 1;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const parsed = parseOutput(rest[i + 1]);
      if (typeof parsed === 'object') return { kind: 'error', message: parsed.error };
      output = parsed;
      i += 1;
      continue;
    }
    if (arg === '-v' || arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--color') {
      const value = rest[i + 1];
      if (value !== 'always' && value !== 'never') {
        return { kind: 'error', message: '--color must be "always" or "never"' };
      }
      color = value;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for diff: ${arg}` };
  }
  if (file === undefined) {
    return { kind: 'error', message: 'diff requires -f / --file' };
  }
  return {
    kind: 'diff',
    file,
    output,
    verbose,
    ...(color !== undefined ? { color } : {}),
  };
}

export const USAGE = `k1c — apply a subset of Kubernetes manifests to Cloudflare

usage:
  k1c apply    -f <file|dir|-> [--dry-run | --watch | --validate-only] [--quiet | -q]
  k1c diff     -f <file|dir|-> [-o text|json] [-v|--verbose] [--color always|never]
  k1c delete   -f <file|dir|-> [--cascade]
  k1c get      <kind> [name] [-n <namespace>] [-o text|json]
  k1c describe <kind> <name> [-n <namespace>] [-o text|json]
  k1c rollout  {status|promote|abort} <ns>/<name> --dispatch <name>
  k1c logs     <kind> <name> [-n <namespace>] [--format pretty|json] [--status <s>] [--limit N]
  k1c port-forward <kind> <name> [-n <namespace>] [--port 8787]
  k1c telemetry workers <kind> <name> [-n <ns>] [--since 1h] [-o text|json]
  k1c explain  <kind> [--recursive | -r]
  k1c config   list | current-context
  k1c config   use-context <name>
  k1c config   set-context <name> --account <id> [--zone <id>] [--token-env CLOUDFLARE_API_TOKEN]
  k1c config   delete-context <name>
  k1c version

context selection (highest wins):
  --context <name>  ⏵  K1C_CONTEXT  ⏵  currentContext from ~/.k1c/config.yaml
  ⏵  legacy K1C_ACCOUNT_ID + CLOUDFLARE_API_TOKEN env

environment:
  K1C_ACCOUNT_ID        Cloudflare account id
  CLOUDFLARE_API_TOKEN  API token with Workers Edit + R2 + KV permissions
`;
