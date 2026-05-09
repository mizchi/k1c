import { describe, it, expect } from 'vitest';
import { runLogs, runPortForward } from './wrangler.ts';

interface Captured {
  cmd?: string;
  args?: ReadonlyArray<string>;
  stdout: string[];
  stderr: string[];
  exit: number;
}

function buildDeps(exit = 0) {
  const captured: Captured = { stdout: [], stderr: [], exit };
  return {
    captured,
    deps: {
      run: async (cmd: string, args: ReadonlyArray<string>) => {
        captured.cmd = cmd;
        captured.args = args;
        return exit;
      },
      out: (m: string) => captured.stdout.push(m),
      err: (m: string) => captured.stderr.push(m),
    },
  };
}

describe('runLogs', () => {
  it('translates a Deployment into the underlying k1c-- script name and forwards format/status', async () => {
    const { captured, deps } = buildDeps();
    const code = await runLogs(
      {
        kind: 'logs',
        resourceKind: 'Deployment',
        name: 'api',
        namespace: 'prod',
        format: 'json',
        status: 'error',
        limit: 10,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(captured.cmd).toBe('wrangler');
    expect(captured.args).toEqual([
      'tail',
      'k1c--prod--api',
      '--format',
      'json',
      '--status',
      'error',
      '--limit',
      '10',
    ]);
  });

  it('defaults namespace to "default" and format to "pretty" when unspecified', async () => {
    const { captured, deps } = buildDeps();
    await runLogs(
      { kind: 'logs', resourceKind: 'Worker', name: 'hello', format: 'pretty', limit: 0 },
      deps,
    );
    expect(captured.args).toEqual(['tail', 'k1c--default--hello', '--format', 'pretty']);
  });

  it('rejects kinds that do not lower to a Worker', async () => {
    const { captured, deps } = buildDeps();
    const code = await runLogs(
      { kind: 'logs', resourceKind: 'Service', name: 'lb', format: 'pretty', limit: 0 },
      deps,
    );
    expect(code).toBe(2);
    expect(captured.cmd).toBeUndefined();
    expect(captured.stderr.join('\n')).toMatch(/cannot tail kind "Service"/);
  });
});

describe('runPortForward', () => {
  it('invokes wrangler dev --remote on the resolved script name and chosen port', async () => {
    const { captured, deps } = buildDeps();
    await runPortForward(
      { kind: 'port-forward', resourceKind: 'Deployment', name: 'api', localPort: 9000 },
      deps,
    );
    expect(captured.cmd).toBe('wrangler');
    expect(captured.args).toEqual([
      'dev',
      '--remote',
      '--name',
      'k1c--default--api',
      '--port',
      '9000',
    ]);
  });
});
