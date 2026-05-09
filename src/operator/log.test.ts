import { describe, expect, it } from 'vitest';
import { createLogger } from './log.ts';

function captured() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr };
}

const FIXED_NOW = () => new Date('2026-05-09T15:00:00.000Z');

describe('createLogger', () => {
  it('text mode prints raw msg to stdout for info, stderr for warn/error', () => {
    const c = captured();
    const log = createLogger({
      format: 'text',
      stdout: (l) => c.stdout.push(l),
      stderr: (l) => c.stderr.push(l),
    });
    log.info('reconcile: 1 ok');
    log.warn('warning: 1 skipped');
    log.error('failed: R2Bucket default/x: 404');
    expect(c.stdout).toEqual(['reconcile: 1 ok']);
    expect(c.stderr).toEqual(['warning: 1 skipped', 'failed: R2Bucket default/x: 404']);
  });

  it('text mode appends fields key=value', () => {
    const c = captured();
    const log = createLogger({
      format: 'text',
      stdout: (l) => c.stdout.push(l),
      stderr: () => {},
    });
    log.info('reconcile pass', { ok: 3, failed: 0 });
    expect(c.stdout[0]).toBe('reconcile pass ok=3 failed=0');
  });

  it('json mode emits one JSON object per line with time + level + msg', () => {
    const c = captured();
    const log = createLogger({
      format: 'json',
      stdout: (l) => c.stdout.push(l),
      stderr: (l) => c.stderr.push(l),
      now: FIXED_NOW,
    });
    log.info('hello');
    log.error('boom', { code: 500, kind: 'R2Bucket' });
    const a = JSON.parse(c.stdout[0]!);
    const b = JSON.parse(c.stderr[0]!);
    expect(a).toEqual({ time: '2026-05-09T15:00:00.000Z', level: 'info', msg: 'hello' });
    expect(b).toEqual({
      time: '2026-05-09T15:00:00.000Z',
      level: 'error',
      msg: 'boom',
      code: 500,
      kind: 'R2Bucket',
    });
  });

  it('json mode merges default fields onto every record', () => {
    const c = captured();
    const log = createLogger({
      format: 'json',
      stdout: (l) => c.stdout.push(l),
      stderr: () => {},
      now: FIXED_NOW,
      defaults: { component: 'k1c-operator', pod: 'k1c-operator-abc' },
    });
    log.info('startup');
    const a = JSON.parse(c.stdout[0]!);
    expect(a).toMatchObject({ component: 'k1c-operator', pod: 'k1c-operator-abc' });
  });

  it('text mode quotes whitespace-bearing field values', () => {
    const c = captured();
    const log = createLogger({
      format: 'text',
      stdout: (l) => c.stdout.push(l),
      stderr: () => {},
    });
    log.info('hello', { greeting: 'good morning' });
    expect(c.stdout[0]).toBe('hello greeting="good morning"');
  });
});
