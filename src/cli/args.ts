export interface ApplyArgs {
  readonly kind: 'apply';
  readonly file: string;
  readonly dryRun: boolean;
}

export interface DiffArgs {
  readonly kind: 'diff';
  readonly file: string;
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
}

export interface DescribeArgs {
  readonly kind: 'describe';
  readonly resourceKind: string;
  readonly name: string;
  readonly namespace?: string;
}

export interface DeleteArgs {
  readonly kind: 'delete';
  readonly file: string;
  readonly cascade: boolean;
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
  | HelpArgs
  | ErrorArgs;

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) return { kind: 'help' };
  const first = argv[0]!;
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === 'apply') return parseApply(argv.slice(1));
  if (first === 'diff') return parseDiff(argv.slice(1));
  if (first === 'rollout') return parseRollout(argv.slice(1));
  if (first === 'get') return parseGet(argv.slice(1));
  if (first === 'describe') return parseDescribe(argv.slice(1));
  if (first === 'delete') return parseDelete(argv.slice(1));
  return { kind: 'error', message: `unknown command: ${first}` };
}

function parseGet(rest: ReadonlyArray<string>): ParsedArgs {
  const resourceKind = rest[0];
  if (resourceKind === undefined || resourceKind.startsWith('-')) {
    return { kind: 'error', message: 'get requires a resource kind (e.g. Worker, R2Bucket)' };
  }
  let name: string | undefined;
  let namespace: string | undefined;
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
    return { kind: 'error', message: `unknown flag for get: ${arg}` };
  }
  return {
    kind: 'get',
    resourceKind,
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
  for (let i = 2; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-n' || arg === '--namespace') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      namespace = value;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for describe: ${arg}` };
  }
  return {
    kind: 'describe',
    resourceKind,
    name,
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
    return { kind: 'error', message: `unknown flag for apply: ${arg}` };
  }
  if (file === undefined) {
    return { kind: 'error', message: 'apply requires -f / --file' };
  }
  return { kind: 'apply', file, dryRun };
}

function parseDiff(rest: ReadonlyArray<string>): ParsedArgs {
  let file: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '-f' || arg === '--file') {
      const value = rest[i + 1];
      if (value === undefined) return { kind: 'error', message: `${arg} requires a value` };
      file = value;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown flag for diff: ${arg}` };
  }
  if (file === undefined) {
    return { kind: 'error', message: 'diff requires -f / --file' };
  }
  return { kind: 'diff', file };
}

export const USAGE = `k1c — apply a subset of Kubernetes manifests to Cloudflare

usage:
  k1c apply    -f <manifest.yaml> [--dry-run]
  k1c diff     -f <manifest.yaml>
  k1c delete   -f <manifest.yaml> [--cascade]
  k1c get      <kind> [name] [-n <namespace>]
  k1c describe <kind> <name> [-n <namespace>]
  k1c rollout  {status|promote|abort} <ns>/<name> --dispatch <name>

environment:
  K1C_ACCOUNT_ID        Cloudflare account id
  CLOUDFLARE_API_TOKEN  API token with Workers Edit + R2 + KV permissions
`;
