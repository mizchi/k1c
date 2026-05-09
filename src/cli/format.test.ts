import { describe, it, expect } from 'vitest';
import type { ResourceRef } from '../manifest/types.ts';
import type { ApplyReport, Operation, Plan } from '../reconciler/types.ts';
import { formatFieldDiff, formatPlan, formatReport } from './format.ts';

const ref = (kind: ResourceRef['kind'], name: string, ns = 'default'): ResourceRef => ({
  apiVersion: kind === 'R2Bucket' || kind === 'KVNamespace' ? 'cloudflare.k1c.io/v1alpha1' : 'apps/v1',
  kind,
  namespace: ns,
  name,
});

describe('formatPlan', () => {
  it('renders empty plan as a no-changes message', () => {
    const out = formatPlan({ operations: [] });
    expect(out).toMatch(/no changes/i);
  });

  it('lists operations with kind, resourceType, and label', () => {
    const ops: Operation[] = [
      {
        kind: 'create',
        resourceType: 'R2Bucket',
        ref: ref('R2Bucket', 'media'),
        label: 'default/media',
        properties: {},
      },
      {
        kind: 'noop',
        resourceType: 'KVNamespace',
        ref: ref('KVNamespace', 'cache'),
        label: 'default/cache',
      },
      {
        kind: 'delete',
        resourceType: 'Worker',
        nativeId: 'k1c--default--old',
        label: 'default/old',
      },
    ];
    const plan: Plan = { operations: ops };
    const out = formatPlan(plan);
    expect(out).toMatch(/CREATE\s+R2Bucket\s+default\/media/);
    expect(out).toMatch(/NOOP\s+KVNamespace\s+default\/cache/);
    expect(out).toMatch(/DELETE\s+Worker\s+default\/old/);
  });
});

describe('formatReport', () => {
  it('shows summary counts', () => {
    const report: ApplyReport = {
      results: [],
      succeeded: 3,
      failed: 1,
      skipped: 2,
    };
    const out = formatReport(report);
    expect(out).toMatch(/3 ok/);
    expect(out).toMatch(/1 failed/);
    expect(out).toMatch(/2 skipped/);
  });

  it('marks failed operations with the error code', () => {
    const op: Operation = {
      kind: 'create',
      resourceType: 'Worker',
      ref: ref('Deployment' as never, 'api'),
      label: 'default/api',
      properties: {},
    };
    const report: ApplyReport = {
      results: [
        {
          op,
          status: 'failed',
          error: { code: 'AccessDenied', recoverable: false, message: 'forbidden' },
        },
      ],
      succeeded: 0,
      failed: 1,
      skipped: 0,
    };
    const out = formatReport(report);
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/AccessDenied/);
    expect(out).toMatch(/default\/api/);
  });

  it('marks succeeded operations and includes nativeId when present', () => {
    const op: Operation = {
      kind: 'create',
      resourceType: 'Worker',
      ref: ref('Deployment' as never, 'api'),
      label: 'default/api',
      properties: {},
    };
    const report: ApplyReport = {
      results: [{ op, status: 'succeeded', nativeId: 'native-id-1' }],
      succeeded: 1,
      failed: 0,
      skipped: 0,
    };
    const out = formatReport(report);
    expect(out).toMatch(/ok/);
    expect(out).toMatch(/native-id-1/);
  });
});

describe('formatFieldDiff', () => {
  it('emits +/- lines for added / removed leaves', () => {
    const lines = formatFieldDiff(
      { compatibilityDate: '2025-01-01' },
      { compatibilityDate: '2025-01-01', observability: { enabled: true } },
      false,
    );
    // Newly-added subtrees are summarized with a single + line carrying the
    // whole object value (rather than a nested walk), since every leaf below
    // is also "new" and would just bloat the output.
    expect(lines.join('\n')).toMatch(/\+ observability:.*"enabled":true/);
    expect(lines.find((l) => l.includes('compatibilityDate'))).toBeUndefined();
  });

  it('emits ~ lines for changed leaves with the old → new value', () => {
    const lines = formatFieldDiff(
      { cache: true, edgeTtl: { mode: 'respect_origin' } },
      { cache: false, edgeTtl: { mode: 'override_origin' } },
      false,
    );
    expect(lines).toContain('~ cache: true → false');
    expect(lines.some((l) => l.includes('edgeTtl.mode'))).toBe(true);
  });

  it('walks arrays by index', () => {
    const lines = formatFieldDiff(
      { bindings: [{ type: 'kv_namespace', name: 'A', namespaceId: 'old' }] },
      { bindings: [{ type: 'kv_namespace', name: 'A', namespaceId: 'new' }] },
      false,
    );
    expect(lines.some((l) => l.includes('bindings[0].namespaceId'))).toBe(true);
  });

  it('returns no lines when objects are deeply equal', () => {
    const lines = formatFieldDiff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }, false);
    expect(lines).toHaveLength(0);
  });

  it('wraps lines in ANSI escapes when color=true', () => {
    const lines = formatFieldDiff({ a: 1 }, { a: 2 }, true);
    expect(lines[0]).toContain('\x1b[33m');
    expect(lines[0]).toContain('\x1b[0m');
  });
});
