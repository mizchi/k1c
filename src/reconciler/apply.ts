import type { ProviderContext, ProviderError } from '../providers/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type {
  ApplyReport,
  Operation,
  OperationResult,
  Plan,
} from './types.ts';

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
    const result = await runOperation(op, registry, ctx, opts);
    results.push(result);
    if (result.status === 'failed') aborted = true;
  }

  return summarize(results);
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
