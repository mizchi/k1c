import * as k8s from '@kubernetes/client-node';

/**
 * One target of a watch loop. `group` is the empty string for core/v1
 * resources; `version` is always required. `labelSelector` (if set) is
 * passed as a query parameter so the apiserver filters server-side.
 */
export interface KindSpec {
  readonly group: string;
  readonly version: string;
  readonly plural: string;
  readonly labelSelector?: string;
}

export interface WatchOptions {
  /** Restrict watches to a single namespace; default: cluster-wide. */
  readonly namespace?: string;
  readonly signal: AbortSignal;
  /** Fired on every accepted event (ADDED / MODIFIED / DELETED). */
  readonly onEvent: (kind: KindSpec, phase: string) => void;
  /** Fired when the watch errors or reconnects; informational. */
  readonly onWarning?: (msg: string) => void;
  /** Backoff between reconnect attempts. Default 2s. */
  readonly reconnectDelayMs?: number;
}

/**
 * Open one watch per spec in `kinds`. Each watch runs as an independent
 * loop that auto-reconnects on apiserver-side close. Returns once every
 * watch has been requested (the loops continue running in the
 * background until `signal` aborts).
 *
 * The k8s SDK's `Watch.watch()` already adds `?watch=true` to the query
 * and parses the streamed event lines into `(phase, apiObj)` callback
 * invocations, so we don't deal with chunked HTTP at this layer.
 */
export function startWatches(
  kc: k8s.KubeConfig,
  kinds: ReadonlyArray<KindSpec>,
  options: WatchOptions,
): void {
  const watch = new k8s.Watch(kc);
  for (const spec of kinds) {
    void runWatchLoop(watch, spec, options);
  }
}

async function runWatchLoop(
  watch: k8s.Watch,
  spec: KindSpec,
  options: WatchOptions,
): Promise<void> {
  const onWarning = options.onWarning ?? ((m) => console.warn(m));
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  while (!options.signal.aborted) {
    const closed = new Promise<void>((resolveClose) => {
      void openOne(watch, spec, options, resolveClose, onWarning);
    });
    await closed;
    if (options.signal.aborted) break;
    // Soft backoff before reconnect; aborts cancel the wait early.
    await sleep(reconnectDelayMs, options.signal);
  }
}

async function openOne(
  watch: k8s.Watch,
  spec: KindSpec,
  options: WatchOptions,
  resolveClose: () => void,
  onWarning: (msg: string) => void,
): Promise<void> {
  const path = buildPath(spec, options.namespace);
  const queryParams: Record<string, string> = {};
  if (spec.labelSelector) queryParams['labelSelector'] = spec.labelSelector;
  let ac: AbortController | undefined;
  const onAbort = () => {
    try {
      ac?.abort();
    } finally {
      resolveClose();
    }
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    ac = await watch.watch(
      path,
      queryParams,
      (phase) => options.onEvent(spec, phase),
      (err) => {
        // The done callback fires both on graceful close (server-side
        // close after ~30 min) and on real errors. Surface real errors
        // as warnings, then resolve so the outer loop reconnects.
        if (err && !(err instanceof Error && err.name === 'AbortError')) {
          onWarning(`watch ${spec.plural}: ${formatErr(err)}`);
        }
        resolveClose();
      },
    );
  } catch (e) {
    onWarning(`watch ${spec.plural} setup: ${formatErr(e)}`);
    resolveClose();
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === 'object') {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(e);
}

export function buildPath(spec: KindSpec, namespace?: string): string {
  const groupPart = spec.group === '' ? '/api' : `/apis/${spec.group}`;
  if (namespace) {
    return `${groupPart}/${spec.version}/namespaces/${namespace}/${spec.plural}`;
  }
  return `${groupPart}/${spec.version}/${spec.plural}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
