/**
 * Operator log format.
 *
 * `text` is the human-readable default — every entry is one line on
 * stdout (info) or stderr (warn/error), no timestamps (the kubelet /
 * docker logs driver adds those).
 *
 * `json` emits one JSON object per line with `time`, `level`, `msg`
 * and any structured fields the call site passes. Designed for
 * container log aggregators (CloudWatch / Loki / Stackdriver) that
 * key off the JSON shape.
 */
export type LogFormat = 'text' | 'json';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface LoggerOptions {
  readonly format: LogFormat;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Extra fields stamped on every record (json mode only). */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Override clock for tests. */
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const stdout = options.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const stderr = options.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = options.now ?? (() => new Date());

  const writeJson = (entry: LogEntry): string => {
    const payload: Record<string, unknown> = {
      time: now().toISOString(),
      level: entry.level,
      msg: entry.msg,
      ...options.defaults,
      ...entry.fields,
    };
    return JSON.stringify(payload);
  };

  const writeText = (entry: LogEntry): string => {
    if (!entry.fields || Object.keys(entry.fields).length === 0) return entry.msg;
    const tail = Object.entries(entry.fields)
      .map(([k, v]) => `${k}=${formatTextField(v)}`)
      .join(' ');
    return `${entry.msg} ${tail}`;
  };

  const emit = (entry: LogEntry) => {
    const line = options.format === 'json' ? writeJson(entry) : writeText(entry);
    if (entry.level === 'info') stdout(line);
    else stderr(line);
  };

  return {
    info: (msg, fields) => emit({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => emit({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => emit({ level: 'error', msg, ...(fields ? { fields } : {}) }),
  };
}

function formatTextField(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
