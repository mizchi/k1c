import { parseManifest } from '../manifest/parse.ts';
import { lower } from '../manifest/lower.ts';
import { plan } from '../reconciler/plan.ts';
import { apply } from '../reconciler/apply.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ProviderContext } from '../providers/types.ts';
import type { ApplyArgs, DeleteArgs, DescribeArgs, DiffArgs, GetArgs } from './args.ts';
import { NotFound } from '../providers/types.ts';
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
  if (args.output === 'json') {
    deps.out(JSON.stringify({ operations: planResult.operations }, null, 2));
  } else {
    deps.out('[plan]');
    deps.out(formatPlan(planResult));
  }
  return 0;
}

export async function runGet(args: GetArgs, deps: RunDeps): Promise<number> {
  if (!deps.registry.has(args.resourceKind)) {
    deps.err(`unknown resource kind: ${args.resourceKind}`);
    return 2;
  }
  const provider = deps.registry.get(args.resourceKind);
  const rows: Array<{ label: string; nativeId: string }> = [];
  try {
    for await (const item of provider.list(deps.providerCtx)) {
      if (args.namespace !== undefined && !item.label.startsWith(`${args.namespace}/`)) continue;
      if (args.name !== undefined && !item.label.endsWith(`/${args.name}`)) continue;
      rows.push({ label: item.label, nativeId: item.nativeId });
    }
  } catch (e) {
    deps.err(`get failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (args.output === 'json') {
    deps.out(JSON.stringify({ kind: args.resourceKind, items: rows }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    deps.out(`(no ${args.resourceKind} resources found)`);
    return 0;
  }
  const labelW = Math.max(8, ...rows.map((r) => r.label.length));
  deps.out(`${pad('LABEL', labelW)}  NATIVE_ID`);
  for (const r of rows) deps.out(`${pad(r.label, labelW)}  ${r.nativeId}`);
  return 0;
}

export async function runDescribe(args: DescribeArgs, deps: RunDeps): Promise<number> {
  if (!deps.registry.has(args.resourceKind)) {
    deps.err(`unknown resource kind: ${args.resourceKind}`);
    return 2;
  }
  const provider = deps.registry.get(args.resourceKind);
  const ns = args.namespace ?? 'default';
  const targetLabel = `${ns}/${args.name}`;
  let nativeId: string | null = null;
  try {
    for await (const item of provider.list(deps.providerCtx)) {
      if (item.label === targetLabel) {
        nativeId = item.nativeId;
        break;
      }
    }
  } catch (e) {
    deps.err(`describe failed during list: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (nativeId === null) {
    deps.err(`${args.resourceKind} ${targetLabel} not found`);
    return 1;
  }
  let props;
  try {
    props = await provider.read(deps.providerCtx, nativeId);
  } catch (e) {
    deps.err(`describe failed during read: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (props === NotFound) {
    deps.err(`${args.resourceKind} ${targetLabel} (nativeId=${nativeId}) was listed but read returned NotFound`);
    return 1;
  }
  if (args.output === 'json') {
    deps.out(
      JSON.stringify(
        {
          kind: args.resourceKind,
          label: targetLabel,
          nativeId,
          properties: props,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  deps.out(`Kind:       ${args.resourceKind}`);
  deps.out(`Label:      ${targetLabel}`);
  deps.out(`NativeID:   ${nativeId}`);
  deps.out('Properties:');
  deps.out(indent(JSON.stringify(props, null, 2), 2));
  return 0;
}

export async function runDelete(args: DeleteArgs, deps: RunDeps): Promise<number> {
  const loaded = await loadParsedAndDesired(args.file, deps);
  if (loaded === null) return 3;

  const targets: Array<{ resourceType: string; label: string }> = [];
  for (const d of loaded.desired) {
    if (!args.cascade && (d.resourceType === 'R2Bucket' || d.resourceType === 'KVNamespace')) {
      deps.out(`(skipping ${d.resourceType} ${d.label} — pass --cascade to delete user data)`);
      continue;
    }
    targets.push({ resourceType: d.resourceType, label: d.label });
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of targets) {
    if (!deps.registry.has(t.resourceType)) {
      deps.err(`no provider for ${t.resourceType}; skipping ${t.label}`);
      skipped += 1;
      continue;
    }
    const provider = deps.registry.get(t.resourceType);
    let nativeId: string | null = null;
    try {
      for await (const item of provider.list(deps.providerCtx)) {
        if (item.label === t.label) {
          nativeId = item.nativeId;
          break;
        }
      }
    } catch (e) {
      deps.err(`delete: list failed for ${t.resourceType} ${t.label}: ${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
      continue;
    }
    if (nativeId === null) {
      deps.out(`(${t.resourceType} ${t.label} not found in cluster, skipping)`);
      skipped += 1;
      continue;
    }
    try {
      await provider.delete(deps.providerCtx, nativeId);
      deps.out(`deleted ${t.resourceType} ${t.label} (${nativeId})`);
      succeeded += 1;
    } catch (e) {
      deps.err(`failed to delete ${t.resourceType} ${t.label}: ${e instanceof Error ? e.message : String(e)}`);
      failed += 1;
    }
  }
  deps.out(`summary: ${succeeded} deleted / ${failed} failed / ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

function indent(text: string, n: number): string {
  const prefix = ' '.repeat(n);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

type LowerDesired = Awaited<ReturnType<typeof lower>>['desired'];

interface Loaded {
  readonly parsed: ReadonlyArray<K1cResource>;
  readonly desired: LowerDesired;
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
    lowered = await lower(parsed.resources, {
      readFile: deps.providerCtx.readFile,
    });
  } catch (e) {
    deps.err(`lower error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return { parsed: parsed.resources, desired: lowered.desired };
}
