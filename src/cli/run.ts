import { parseManifest } from '../manifest/parse.ts';
import { lower } from '../manifest/lower.ts';
import { plan } from '../reconciler/plan.ts';
import { apply } from '../reconciler/apply.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ProviderContext } from '../providers/types.ts';
import type { ApplyArgs, DiffArgs } from './args.ts';
import { formatPlan, formatReport } from './format.ts';
import { advanceCanaryRolloutsForApply } from './canary-integration.ts';
import type { K1cResource } from '../manifest/types.ts';

export interface RunDeps {
  readonly registry: ProviderRegistry;
  readonly providerCtx: ProviderContext;
  readonly readManifest: (path: string) => Promise<string>;
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

export async function runApply(args: ApplyArgs, deps: RunDeps): Promise<number> {
  const loaded = await loadParsedAndDesired(args.file, deps);
  if (loaded === null) return 3;
  const { parsed, desired } = loaded;

  const planResult = await plan(desired, deps.registry, deps.providerCtx);
  deps.out('[plan]');
  deps.out(formatPlan(planResult));

  if (args.dryRun) {
    deps.out('');
    deps.out('(dry-run: no changes applied)');
    return 0;
  }

  let exitCode = 0;
  if (planResult.operations.length > 0) {
    deps.out('');
    deps.out('[apply]');
    const report = await apply(planResult, deps.registry, deps.providerCtx);
    deps.out(formatReport(report));
    if (report.failed > 0) exitCode = 1;
  }

  if (exitCode === 0) {
    try {
      await advanceCanaryRolloutsForApply(parsed, desired, {
        providerCtx: deps.providerCtx,
        out: deps.out,
        err: deps.err,
        now: () => new Date(),
      });
    } catch (e) {
      deps.err(`canary advance failed: ${e instanceof Error ? e.message : String(e)}`);
      exitCode = 1;
    }
  }

  return exitCode;
}

export async function runDiff(args: DiffArgs, deps: RunDeps): Promise<number> {
  const loaded = await loadParsedAndDesired(args.file, deps);
  if (loaded === null) return 3;
  const planResult = await plan(loaded.desired, deps.registry, deps.providerCtx);
  deps.out('[plan]');
  deps.out(formatPlan(planResult));
  return 0;
}

interface Loaded {
  readonly parsed: ReadonlyArray<K1cResource>;
  readonly desired: ReadonlyArray<ReturnType<typeof lower>['desired'][number]>;
}

async function loadParsedAndDesired(file: string, deps: RunDeps): Promise<Loaded | null> {
  let yamlText: string;
  try {
    yamlText = await deps.readManifest(file);
  } catch (e) {
    deps.err(`failed to read manifest ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  let parsed;
  try {
    parsed = parseManifest(yamlText);
  } catch (e) {
    deps.err(`manifest parse error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  for (const w of parsed.warnings) {
    const where = w.ref ? `${w.ref.kind}/${w.ref.namespace}/${w.ref.name}` : '';
    deps.err(`warning: ${where} ${w.message}`);
  }

  let lowered;
  try {
    lowered = lower(parsed.resources);
  } catch (e) {
    deps.err(`lower error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return { parsed: parsed.resources, desired: lowered.desired };
}
