import type { ApplyReport, Operation, Plan } from '../reconciler/types.ts';

const KIND_WIDTH = 7;
const TYPE_WIDTH = 12;
const LABEL_WIDTH = 24;

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

export interface FormatPlanOptions {
  /** When true, include field-level diffs under each `update` op. */
  readonly verbose?: boolean;
  /** When true, wrap +/- lines in ANSI color (green / red). */
  readonly color?: boolean;
}

export function formatPlan(plan: Plan, options: FormatPlanOptions = {}): string {
  if (plan.operations.length === 0) return '(no changes)';
  const lines: string[] = [];
  for (const op of plan.operations) {
    const kindTag = colorize(op.kind, options.color ?? false);
    const kind = pad(kindTag.text, KIND_WIDTH + kindTag.padding);
    const rt = pad(op.resourceType, TYPE_WIDTH);
    lines.push(`  ${kind} ${rt} ${op.label}`);
    if (options.verbose && op.kind === 'update') {
      for (const line of formatFieldDiff(op.prior, op.properties, options.color ?? false)) {
        lines.push(`    ${line}`);
      }
    }
  }
  return lines.join('\n');
}

interface ColoredKind {
  readonly text: string;
  /** Extra padding budget consumed by ANSI escape sequences (so pad() still aligns visually). */
  readonly padding: number;
}

function colorize(kind: Operation['kind'], color: boolean): ColoredKind {
  const upper = kind.toUpperCase();
  if (!color) return { text: upper, padding: 0 };
  const code =
    kind === 'create'
      ? '\x1b[32m' // green
      : kind === 'update'
        ? '\x1b[33m' // yellow
        : kind === 'delete'
          ? '\x1b[31m' // red
          : '\x1b[2m'; // dim for noop
  const reset = '\x1b[0m';
  return { text: `${code}${upper}${reset}`, padding: code.length + reset.length };
}

/**
 * Walks two property objects and emits `+key: value` / `-key: value` lines
 * for every leaf-level difference. Nested objects are rendered with a
 * dotted path (`bindings[0].name`) so each diff is one line.
 */
export function formatFieldDiff(
  prior: unknown,
  desired: unknown,
  color: boolean,
): ReadonlyArray<string> {
  const out: string[] = [];
  walk('', prior, desired, out);
  return out.map((l) => paint(l, color));
}

function paint(line: string, color: boolean): string {
  if (!color) return line;
  if (line.startsWith('+')) return `\x1b[32m${line}\x1b[0m`;
  if (line.startsWith('-')) return `\x1b[31m${line}\x1b[0m`;
  if (line.startsWith('~')) return `\x1b[33m${line}\x1b[0m`;
  return line;
}

function walk(path: string, a: unknown, b: unknown, out: string[]): void {
  // Identical leaves: skip.
  if (canon(a) === canon(b)) return;
  if (isObj(a) && isObj(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      walk(path === '' ? k : `${path}.${k}`, a[k], b[k], out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      walk(`${path}[${i}]`, a[i], b[i], out);
    }
    return;
  }
  if (a === undefined && b !== undefined) {
    out.push(`+ ${path}: ${shortRepr(b)}`);
    return;
  }
  if (a !== undefined && b === undefined) {
    out.push(`- ${path}: ${shortRepr(a)}`);
    return;
  }
  out.push(`~ ${path}: ${shortRepr(a)} → ${shortRepr(b)}`);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function canon(x: unknown): string {
  return JSON.stringify(x ?? null);
}

function shortRepr(x: unknown): string {
  if (typeof x === 'string') {
    if (x.length > 60) return JSON.stringify(`${x.slice(0, 57)}...`);
    return JSON.stringify(x);
  }
  if (typeof x === 'number' || typeof x === 'boolean' || x === null) return String(x);
  const json = JSON.stringify(x);
  if (json.length > 80) return `${json.slice(0, 77)}...`;
  return json;
}

export function formatReport(report: ApplyReport): string {
  const lines = report.results.map((r) => formatResult(r.op, r.status, r.nativeId, r.error));
  lines.push('');
  lines.push(`summary: ${report.succeeded} ok / ${report.failed} failed / ${report.skipped} skipped`);
  return lines.join('\n');
}

function formatResult(
  op: Operation,
  status: 'succeeded' | 'failed' | 'skipped',
  nativeId: string | undefined,
  error: { code: string; message: string } | undefined,
): string {
  const tag = pad(statusTag(status), 8);
  const kind = pad(op.kind.toUpperCase(), KIND_WIDTH);
  const rt = pad(op.resourceType, TYPE_WIDTH);
  const label = pad(op.label, LABEL_WIDTH);
  const trail = error
    ? `${error.code}: ${error.message}`
    : nativeId !== undefined
      ? `(${nativeId})`
      : '';
  return `  ${tag} ${kind} ${rt} ${label}${trail ? ' ' + trail : ''}`;
}

function statusTag(status: 'succeeded' | 'failed' | 'skipped'): string {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed') return 'FAILED';
  return 'skip';
}
