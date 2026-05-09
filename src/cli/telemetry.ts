import process from 'node:process';
import type { TelemetryArgs } from './args.ts';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

const WORKERS_QUERY = `
  query Workers($accountTag: string!, $scriptName: string!, $since: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          filter: { scriptName: $scriptName, datetime_geq: $since }
          limit: 10000
        ) {
          sum {
            requests
            subrequests
            errors
          }
          quantiles {
            cpuTimeP99
            wallTimeP99
            responseBodySizeP99
          }
        }
      }
    }
  }
`;

interface WorkersAggregateRow {
  sum?: {
    requests?: number;
    subrequests?: number;
    errors?: number;
  };
  quantiles?: {
    cpuTimeP99?: number;
    wallTimeP99?: number;
    responseBodySizeP99?: number;
  };
}

export interface TelemetryDeps {
  readonly accountId: string;
  readonly apiToken: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
  /** Override `Date.now` for tests. */
  readonly now?: () => Date;
}

/**
 * Resolve a manifest <kind, name, namespace> into the underlying Worker
 * script name. Mirrors the same mapping `k1c logs` uses.
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
        error: `cannot query telemetry for kind "${resourceKind}": only Worker-backed kinds are supported`,
      };
  }
}

/** `5m` / `1h` / `24h` / `7d` → ISO-8601 timestamp `since`. */
export function durationToSince(duration: string, now: Date): string {
  const m = /^(\d+)([smhd])$/.exec(duration);
  if (!m) throw new Error(`invalid duration: ${duration}`);
  const n = Number(m[1]);
  const unit = m[2]!;
  const ms =
    unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
  return new Date(now.getTime() - ms).toISOString();
}

export async function runTelemetry(args: TelemetryArgs, deps: TelemetryDeps): Promise<number> {
  const out = deps.out ?? ((m) => process.stdout.write(`${m}\n`));
  const err = deps.err ?? ((m) => process.stderr.write(`${m}\n`));
  const fetchFn = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();

  const script = workerScriptName(args.resourceKind, args.name, args.namespace);
  if (typeof script !== 'string') {
    err(script.error);
    return 2;
  }

  const since = durationToSince(args.since, now);
  let response: Response;
  try {
    response = await fetchFn(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.apiToken}`,
      },
      body: JSON.stringify({
        query: WORKERS_QUERY,
        variables: { accountTag: deps.accountId, scriptName: script, since },
      }),
    });
  } catch (e) {
    err(`telemetry request failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!response.ok) {
    err(`telemetry HTTP ${response.status} ${response.statusText}`);
    return 1;
  }
  const body = (await response.json()) as {
    data?: {
      viewer?: {
        accounts?: ReadonlyArray<{
          workersInvocationsAdaptive?: ReadonlyArray<WorkersAggregateRow>;
        }>;
      };
    };
    errors?: ReadonlyArray<{ message: string }>;
  };
  if (body.errors?.length) {
    for (const e of body.errors) err(`graphql error: ${e.message}`);
    return 1;
  }
  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  let totalRequests = 0;
  let totalSubrequests = 0;
  let totalErrors = 0;
  let cpuP99 = 0;
  let wallP99 = 0;
  for (const r of rows) {
    totalRequests += r.sum?.requests ?? 0;
    totalSubrequests += r.sum?.subrequests ?? 0;
    totalErrors += r.sum?.errors ?? 0;
    cpuP99 = Math.max(cpuP99, r.quantiles?.cpuTimeP99 ?? 0);
    wallP99 = Math.max(wallP99, r.quantiles?.wallTimeP99 ?? 0);
  }
  const errorRate = totalRequests === 0 ? 0 : totalErrors / totalRequests;
  // Window in seconds, derived back from the `since` we sent so the rate
  // matches what the user asked for.
  const windowSec = (now.getTime() - new Date(since).getTime()) / 1000;
  const reqPerSec = windowSec === 0 ? 0 : totalRequests / windowSec;

  if (args.output === 'json') {
    out(
      JSON.stringify(
        {
          script,
          since,
          windowSec,
          requests: totalRequests,
          subrequests: totalSubrequests,
          errors: totalErrors,
          errorRate,
          cpuTimeP99: cpuP99,
          wallTimeP99: wallP99,
          requestsPerSecond: reqPerSec,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  out(`script:        ${script}`);
  out(`window:        last ${args.since} (${windowSec.toFixed(0)}s)`);
  out(`requests:      ${totalRequests.toLocaleString()}`);
  out(`subrequests:   ${totalSubrequests.toLocaleString()}`);
  out(`errors:        ${totalErrors.toLocaleString()} (${(errorRate * 100).toFixed(2)}%)`);
  out(`req/s:         ${reqPerSec.toFixed(3)}`);
  out(`cpu p99 (ms):  ${cpuP99.toFixed(2)}`);
  out(`wall p99 (ms): ${wallP99.toFixed(2)}`);
  return 0;
}
