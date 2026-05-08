import type { ApplyReport, Operation, Plan } from '../reconciler/types.ts';

const KIND_WIDTH = 7;
const TYPE_WIDTH = 12;
const LABEL_WIDTH = 24;

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

export function formatPlan(plan: Plan): string {
  if (plan.operations.length === 0) return '(no changes)';
  const lines = plan.operations.map((op) => {
    const kind = pad(op.kind.toUpperCase(), KIND_WIDTH);
    const rt = pad(op.resourceType, TYPE_WIDTH);
    return `  ${kind} ${rt} ${op.label}`;
  });
  return lines.join('\n');
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
