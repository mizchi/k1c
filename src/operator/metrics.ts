/**
 * Minimal Prometheus exposition for the operator. Hand-rolled to avoid
 * pulling prom-client into the runtime image — the metric set is small
 * and the text format trivial.
 *
 * Surfaces:
 *
 *   k1c_operator_reconcile_total{result="ok|failed|skipped|error"}
 *     Counter: every reconcile op result. `error` is the wrapping
 *     try/catch around tick() (plan() throws etc.); `ok`/`failed`/
 *     `skipped` mirror ApplyReport.
 *
 *   k1c_operator_reconcile_passes_total{outcome="ok|noop|error"}
 *     Counter: one increment per reconcile pass.
 *
 *   k1c_operator_reconcile_duration_seconds_{count,sum}
 *     Naive summary (count + sum) — enough to derive p50/p95 across
 *     scrapes via Prometheus rate() arithmetic.
 *
 *   k1c_operator_watch_events_total{kind="<plural>",phase="..."}
 *     Counter: every event delivered by `watch.ts`'s onEvent callback.
 *
 *   k1c_operator_up
 *     Gauge: 1 while the operator is running. Useful for `up{job=...}`
 *     style alerting that doesn't depend on the kubelet readiness probe.
 */

type Labels = Readonly<Record<string, string>>;

interface Counter {
  readonly help: string;
  readonly buckets: Map<string, number>;
}

interface SummaryAgg {
  readonly help: string;
  count: number;
  sum: number;
}

interface Gauge {
  readonly help: string;
  buckets: Map<string, number>;
}

const counters = new Map<string, Counter>();
const summaries = new Map<string, SummaryAgg>();
const gauges = new Map<string, Gauge>();

function ensureCounter(name: string, help: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = { help, buckets: new Map() };
    counters.set(name, c);
  }
  return c;
}

function ensureGauge(name: string, help: string): Gauge {
  let g = gauges.get(name);
  if (!g) {
    g = { help, buckets: new Map() };
    gauges.set(name, g);
  }
  return g;
}

function ensureSummary(name: string, help: string): SummaryAgg {
  let s = summaries.get(name);
  if (!s) {
    s = { help, count: 0, sum: 0 };
    summaries.set(name, s);
  }
  return s;
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',');
}

function escapeLabel(v: string): string {
  return v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function incCounter(name: string, help: string, labels: Labels = {}, by = 1): void {
  const c = ensureCounter(name, help);
  const k = labelKey(labels);
  c.buckets.set(k, (c.buckets.get(k) ?? 0) + by);
}

export function setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
  const g = ensureGauge(name, help);
  g.buckets.set(labelKey(labels), value);
}

export function observeSummary(name: string, help: string, value: number): void {
  const s = ensureSummary(name, help);
  s.count += 1;
  s.sum += value;
}

/**
 * Render the in-memory state as Prometheus 0.0.4 text format. One pass,
 * deterministic ordering (sorted metric names → sorted label keys).
 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, c] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# HELP ${name} ${c.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [labels, value] of [...c.buckets.entries()].sort()) {
      lines.push(`${name}${labels === '' ? '' : `{${labels}}`} ${value}`);
    }
  }
  for (const [name, g] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# HELP ${name} ${g.help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const [labels, value] of [...g.buckets.entries()].sort()) {
      lines.push(`${name}${labels === '' ? '' : `{${labels}}`} ${value}`);
    }
  }
  for (const [name, s] of [...summaries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# HELP ${name} ${s.help}`);
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}_count ${s.count}`);
    lines.push(`${name}_sum ${s.sum}`);
  }
  return lines.join('\n') + '\n';
}

/** Reset all metrics — used in tests. Production code never calls this. */
export function resetMetrics(): void {
  counters.clear();
  summaries.clear();
  gauges.clear();
}
