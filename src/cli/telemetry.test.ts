import { describe, it, expect, vi } from 'vitest';
import { durationToSince, runTelemetry } from './telemetry.ts';

describe('durationToSince', () => {
  const now = new Date('2026-05-09T12:00:00Z');
  it.each([
    ['5s', '2026-05-09T11:59:55.000Z'],
    ['10m', '2026-05-09T11:50:00.000Z'],
    ['1h', '2026-05-09T11:00:00.000Z'],
    ['24h', '2026-05-08T12:00:00.000Z'],
    ['7d', '2026-05-02T12:00:00.000Z'],
  ])('translates %s into the right ISO time', (input, expected) => {
    expect(durationToSince(input, now)).toBe(expected);
  });

  it('throws on bad duration syntax', () => {
    expect(() => durationToSince('1week', now)).toThrow();
  });
});

describe('runTelemetry: workers', () => {
  it('issues a GraphQL POST against the analytics endpoint with the resolved script name + window', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        auth: (init?.headers as Record<string, string>)?.['authorization'] ?? null,
      });
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      sum: { requests: 1000, subrequests: 200, errors: 5 },
                      quantiles: { cpuTimeP99: 18.5, wallTimeP99: 42.1 },
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const captured: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const code = await runTelemetry(
      {
        kind: 'telemetry',
        subject: 'workers',
        resourceKind: 'Deployment',
        name: 'api',
        namespace: 'prod',
        since: '1h',
        output: 'json',
      },
      {
        accountId: 'acc-123',
        apiToken: 'tok-xyz',
        fetch: fakeFetch,
        out: (m) => captured.stdout.push(m),
        err: (m) => captured.stderr.push(m),
        now: () => new Date('2026-05-09T12:00:00Z'),
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(calls[0]!.auth).toBe('Bearer tok-xyz');
    const body = calls[0]!.body as { variables: Record<string, string> };
    expect(body.variables.scriptName).toBe('k1c--prod--api');
    expect(body.variables.accountTag).toBe('acc-123');
    expect(body.variables.since).toBe('2026-05-09T11:00:00.000Z');

    const json = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(json.script).toBe('k1c--prod--api');
    expect(json.requests).toBe(1000);
    expect(json.errors).toBe(5);
    expect(json.errorRate).toBeCloseTo(0.005);
    expect(json.cpuTimeP99).toBe(18.5);
  });

  it('rejects kinds that do not lower to a Worker', async () => {
    const captured: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const code = await runTelemetry(
      {
        kind: 'telemetry',
        subject: 'workers',
        resourceKind: 'Service',
        name: 'lb',
        since: '1h',
        output: 'text',
      },
      {
        accountId: 'acc-123',
        apiToken: 'tok-xyz',
        fetch: vi.fn(),
        out: (m) => captured.stdout.push(m),
        err: (m) => captured.stderr.push(m),
        now: () => new Date(),
      },
    );
    expect(code).toBe(2);
    expect(captured.stderr.join('\n')).toMatch(/cannot query telemetry for kind "Service"/);
  });

  it('surfaces graphql errors on stderr and exits non-zero', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'invalid scriptName' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const captured: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const code = await runTelemetry(
      {
        kind: 'telemetry',
        subject: 'workers',
        resourceKind: 'Worker',
        name: 'api',
        since: '1h',
        output: 'text',
      },
      {
        accountId: 'acc-123',
        apiToken: 'tok-xyz',
        fetch: fakeFetch,
        out: (m) => captured.stdout.push(m),
        err: (m) => captured.stderr.push(m),
        now: () => new Date(),
      },
    );
    expect(code).toBe(1);
    expect(captured.stderr.join('\n')).toMatch(/invalid scriptName/);
  });
});
