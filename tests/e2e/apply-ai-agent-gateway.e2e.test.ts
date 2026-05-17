import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/providers/index.ts';
import { runApply, runDelete } from '../../src/cli/run.ts';
import { buildE2EContext, e2eEnabled, RUN_ID, safeCleanup } from './_harness.ts';
import type { ProviderContext } from '../../src/providers/types.ts';

const RUN_E2E = e2eEnabled();

function workerSource(className: string): string {
  return `
export class ${className} extends DurableObject {
  fetch() {
    return new Response("ok");
  }
}

export default {
  fetch() {
    return new Response("ok");
  },
};
`;
}

describe.skipIf(!RUN_E2E)('e2e: apply Cloudflare Agents + AI Gateway manifest', () => {
  it('applies, re-applies as no-op, and deletes the managed resources', async () => {
    const gatewayName = `ai-${RUN_ID}`;
    const workerName = `agent-${RUN_ID}`;
    const className = `ChatAgent${RUN_ID}`;
    const manifest = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: AIGateway
metadata: { name: ${gatewayName} }
spec:
  collectLogs: false
  cacheTtl: 0
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${workerName}
  annotations:
    cloudflare.com/ai: enabled
    cloudflare.com/ai-gateway-ref: ${gatewayName}
    cloudflare.com/agent-classes: ${className}
spec:
  selector: { matchLabels: { app: ${workerName} } }
  template:
    spec:
      containers:
        - { name: worker, image: ./e2e-agent.js }
`;
    const registry = createDefaultRegistry();
    const e2e = buildE2EContext();
    const providerCtx: ProviderContext = {
      ...e2e.providerCtx,
      readFile: async () => new TextEncoder().encode(workerSource(className)),
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps = {
      registry,
      providerCtx,
      readManifest: async () => manifest,
      out: (msg: string) => stdout.push(msg),
      err: (msg: string) => stderr.push(msg),
    };

    try {
      const applyArgs = {
        kind: 'apply',
        file: 'inline.yaml',
        dryRun: false,
        watch: false,
        quiet: false,
        validateOnly: false,
      } as const;
      expect(await runApply(applyArgs, deps)).toBe(0);
      stdout.length = 0;
      expect(await runApply(applyArgs, deps)).toBe(0);
      expect(stdout.join('\n')).toContain('(no changes)');
    } finally {
      await safeCleanup(() =>
        runDelete({ kind: 'delete', file: 'inline.yaml', cascade: true }, deps),
      );
    }

    expect(stderr).toEqual([]);
  });
});
