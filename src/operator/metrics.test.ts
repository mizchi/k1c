import { afterEach, describe, expect, it } from 'vitest';
import {
  incCounter,
  observeSummary,
  renderMetrics,
  resetMetrics,
  setGauge,
} from './metrics.ts';

describe('metrics', () => {
  afterEach(() => resetMetrics());

  it('renders counters with labels and HELP/TYPE lines', () => {
    incCounter('k1c_operator_reconcile_total', 'reconcile op results', { result: 'ok' });
    incCounter('k1c_operator_reconcile_total', 'reconcile op results', { result: 'ok' });
    incCounter('k1c_operator_reconcile_total', 'reconcile op results', { result: 'failed' });
    const out = renderMetrics();
    expect(out).toContain('# HELP k1c_operator_reconcile_total reconcile op results');
    expect(out).toContain('# TYPE k1c_operator_reconcile_total counter');
    expect(out).toContain('k1c_operator_reconcile_total{result="ok"} 2');
    expect(out).toContain('k1c_operator_reconcile_total{result="failed"} 1');
  });

  it('renders gauges and summaries', () => {
    setGauge('k1c_operator_up', '1 while running', 1);
    observeSummary('k1c_operator_reconcile_duration_seconds', 'pass duration', 0.5);
    observeSummary('k1c_operator_reconcile_duration_seconds', 'pass duration', 1.5);
    const out = renderMetrics();
    expect(out).toContain('# TYPE k1c_operator_up gauge');
    expect(out).toContain('k1c_operator_up 1');
    expect(out).toContain('k1c_operator_reconcile_duration_seconds_count 2');
    expect(out).toContain('k1c_operator_reconcile_duration_seconds_sum 2');
  });

  it('escapes label values containing quotes / backslashes / newlines', () => {
    incCounter('test_metric', 'help', { msg: 'has "quotes"\nand \\ backslash' });
    const out = renderMetrics();
    expect(out).toContain('msg="has \\"quotes\\"\\nand \\\\ backslash"');
  });

  it('produces a final newline so curl|grep is well-behaved', () => {
    incCounter('test_metric', 'h');
    expect(renderMetrics().endsWith('\n')).toBe(true);
  });

  it('keeps no-label counters distinct from labeled ones', () => {
    incCounter('test_metric', 'h');
    incCounter('test_metric', 'h', { kind: 'a' });
    const out = renderMetrics();
    expect(out).toMatch(/^test_metric 1$/m);
    expect(out).toMatch(/^test_metric\{kind="a"\} 1$/m);
  });
});
