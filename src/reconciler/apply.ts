import type { ProviderContext, ProviderError } from '../providers/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type {
  ApplyReport,
  Operation,
  OperationResult,
  Plan,
} from './types.ts';
import { cacheKey, resolveValue, type ResolutionCache } from './resolve.ts';

export interface ApplyOptions {
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly dryRun?: boolean;
}

const DEFAULT_OPTIONS: Required<ApplyOptions> = {
  retries: 3,
  backoffMs: 200,
  dryRun: false,
};

export async function apply(
  plan: Plan,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  options?: ApplyOptions,
): Promise<ApplyReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // plan() returns operations already topologically ordered:
  // (creates+updates in dependency order) → noops → deletes.
  // apply runs them in that order; hand-constructed plans take responsibility for ordering.
  const results: OperationResult[] = [];

  // Cross-resource ID resolution: as creates and updates succeed they record
  // their native IDs into this cache, and any subsequent operation whose
  // properties carry a `<resolved-at-apply:<type>:<label>>` placeholder for an
  // already-applied resource gets it substituted in-place. See `resolve.ts`.
  const resolutionCache: ResolutionCache = new Map();

  let aborted = false;
  for (const op of plan.operations) {
    if (aborted) {
      results.push({ op, status: 'skipped' });
      continue;
    }
    if (opts.dryRun) {
      results.push({ op, status: 'skipped' });
      continue;
    }
    if (op.kind === 'noop') {
      results.push({ op, status: 'succeeded' });
      continue;
    }
    let resolvedOp: Operation;
    try {
      resolvedOp = await resolveOperation(op, registry, ctx, resolutionCache);
    } catch (raw) {
      // Unresolved placeholders surface as ProviderError-shaped throws; treat
      // them as a hard failure on this op and abort the rest of the plan.
      results.push({ op, status: 'failed', error: toProviderError(raw) });
      aborted = true;
      continue;
    }
    const result = await runOperation(resolvedOp, registry, ctx, opts);
    results.push(result);
    if (result.status === 'succeeded' && result.nativeId !== undefined) {
      const label = (resolvedOp as { label?: string }).label;
      if (label !== undefined) {
        resolutionCache.set(cacheKey(resolvedOp.resourceType, label), result.nativeId);
      }
    }
    if (result.status === 'failed') aborted = true;
  }

  return summarize(results);
}

async function resolveOperation(
  op: Operation,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  cache: ResolutionCache,
): Promise<Operation> {
  if (op.kind !== 'create' && op.kind !== 'update') return op;
  const resolved = await resolveValue(op.properties, registry, ctx, cache);
  return { ...op, properties: resolved };
}

async function runOperation(
  op: Operation,
  registry: ProviderRegistry,
  ctx: ProviderContext,
  opts: Required<ApplyOptions>,
): Promise<OperationResult> {
  let attempt = 0;
  let lastError: ProviderError | undefined;

  while (attempt <= opts.retries) {
    try {
      const nativeId = await execute(op, registry, ctx);
      return { op, status: 'succeeded', ...(nativeId ? { nativeId } : {}) };
    } catch (raw) {
      const err = toProviderError(raw);
      lastError = err;
      if (!err.recoverable) {
        return { op, status: 'failed', error: err };
      }
      attempt += 1;
      if (attempt > opts.retries) break;
      if (opts.backoffMs > 0) await sleep(opts.backoffMs * attempt);
    }
  }
  return { op, status: 'failed', error: lastError ?? unknownError() };
}

async function execute(
  op: Operation,
  registry: ProviderRegistry,
  ctx: ProviderContext,
): Promise<string | undefined> {
  switch (op.kind) {
    case 'create': {
      const provider = registry.get(op.resourceType);
      const result = await provider.create(ctx, op.label, op.properties);
      return result.nativeId;
    }
    case 'update': {
      const provider = registry.get(op.resourceType);
      const result = await provider.update(ctx, op.nativeId, op.prior, op.properties);
      if (result.kind === 'noop') return op.nativeId;
      return result.nativeId;
    }
    case 'delete': {
      const provider = registry.get(op.resourceType);
      await provider.delete(ctx, op.nativeId);
      return op.nativeId;
    }
    case 'noop':
      return undefined;
  }
}

function toProviderError(raw: unknown): ProviderError {
  if (raw && typeof raw === 'object' && 'code' in raw && 'recoverable' in raw) {
    return raw as ProviderError;
  }
  return {
    code: 'ServiceInternalError',
    recoverable: true,
    message: raw instanceof Error ? raw.message : String(raw),
    cause: raw,
  };
}

function unknownError(): ProviderError {
  return {
    code: 'ServiceInternalError',
    recoverable: false,
    message: 'unknown error after retries',
  };
}

function summarize(results: ReadonlyArray<OperationResult>): ApplyReport {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === 'succeeded') succeeded += 1;
    else if (r.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return { results, succeeded, failed, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
