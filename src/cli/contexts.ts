import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * kubeconfig-style multi-account / multi-zone context store.
 *
 * Lives at `$K1C_CONFIG` (default `~/.k1c/config.yaml`). Schema:
 *
 *   currentContext: prod
 *   contexts:
 *     prod:
 *       accountId: 123abc
 *       zoneId: 456def
 *       apiTokenEnv: CLOUDFLARE_API_TOKEN_PROD
 *     staging:
 *       accountId: 789ghi
 *       apiTokenEnv: CLOUDFLARE_API_TOKEN_STAGING
 *
 * Selection precedence (highest wins):
 *
 *   1. `--context <name>` flag
 *   2. `K1C_CONTEXT` env var
 *   3. `currentContext` from the file
 *   4. fall back to `K1C_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` env (legacy)
 *
 * The token itself is never stored in the file — only the *name* of an env
 * var that holds it. This keeps `~/.k1c/config.yaml` safe to commit per
 * machine without leaking secrets.
 */
export interface K1cContext {
  readonly accountId: string;
  readonly zoneId?: string;
  /** Env var name that holds the API token. Defaults to CLOUDFLARE_API_TOKEN. */
  readonly apiTokenEnv?: string;
}

export interface K1cContextFile {
  readonly currentContext?: string;
  readonly contexts: Readonly<Record<string, K1cContext>>;
}

export function configPath(): string {
  return process.env['K1C_CONFIG'] ?? join(homedir(), '.k1c', 'config.yaml');
}

export async function loadContexts(): Promise<K1cContextFile> {
  const path = configPath();
  let text: string;
  try {
    text = (await readFile(path)).toString('utf-8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { contexts: {} };
    throw e;
  }
  const parsed = parseYaml(text) as K1cContextFile | null;
  if (parsed === null) return { contexts: {} };
  return { ...parsed, contexts: parsed.contexts ?? {} };
}

export async function saveContexts(file: K1cContextFile): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(file));
}

export interface ResolvedContext {
  readonly accountId: string;
  readonly zoneId: string | undefined;
  readonly apiToken: string;
  readonly source: 'flag' | 'env' | 'file' | 'legacy';
  readonly name: string | undefined;
}

/**
 * Resolve the effective context for an apply / diff / get / etc. invocation.
 * Returns a structured result so callers can show "using context X" hints
 * without rebuilding the precedence logic.
 */
export async function resolveContext(opts: {
  readonly cliName?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ResolvedContext | { error: string }> {
  const env = opts.env ?? process.env;
  let source: ResolvedContext['source'] = 'legacy';
  let name: string | undefined;

  let entry: K1cContext | undefined;
  if (opts.cliName !== undefined) {
    name = opts.cliName;
    source = 'flag';
  } else if (env['K1C_CONTEXT']) {
    name = env['K1C_CONTEXT'];
    source = 'env';
  }

  if (name !== undefined) {
    const file = await loadContexts();
    entry = file.contexts[name];
    if (!entry) {
      return { error: `context "${name}" is not defined in ${configPath()}` };
    }
  } else {
    const file = await loadContexts();
    if (file.currentContext !== undefined) {
      const candidate = file.contexts[file.currentContext];
      if (candidate !== undefined) {
        name = file.currentContext;
        entry = candidate;
        source = 'file';
      }
    }
  }

  const accountId = entry?.accountId ?? env['K1C_ACCOUNT_ID'];
  const zoneId = entry?.zoneId ?? env['K1C_ZONE_ID'];
  const tokenEnv = entry?.apiTokenEnv ?? 'CLOUDFLARE_API_TOKEN';
  const apiToken = env[tokenEnv];

  if (!accountId) {
    return {
      error: source === 'legacy'
        ? 'K1C_ACCOUNT_ID is not set (or pick a context: --context / K1C_CONTEXT / k1c config use-context)'
        : `context "${name}" has no accountId`,
    };
  }
  if (!apiToken) {
    return {
      error: `${tokenEnv} is not set (carrying the API token for context "${name ?? '(legacy)'}")`,
    };
  }
  return {
    accountId,
    zoneId: zoneId !== undefined && zoneId.length > 0 ? zoneId : undefined,
    apiToken,
    source,
    name,
  };
}
