import { describe, it, expect } from 'vitest';
import { generateRouter } from './router-template.ts';

describe('generateRouter', () => {
  it('embeds the routing table and default backend literally in the source', () => {
    const src = generateRouter({
      routes: [
        {
          host: 'example.com',
          paths: [
            { path: '/api', pathType: 'Prefix', backendBinding: 'b0' },
            { path: '/', pathType: 'Prefix', backendBinding: 'b1' },
          ],
        },
      ],
      defaultBackend: 'b1',
    });
    expect(src).toContain('"host": "example.com"');
    expect(src).toContain('"backendBinding": "b0"');
    expect(src).toContain('const DEFAULT = "b1"');
  });

  it('emits null for the default backend when none is provided', () => {
    const src = generateRouter({
      routes: [
        { host: 'a.test', paths: [{ path: '/', pathType: 'Prefix', backendBinding: 'b0' }] },
      ],
      defaultBackend: null,
    });
    expect(src).toContain('const DEFAULT = null');
  });

  it('matches generated routes with the canonical k8s Prefix semantics', async () => {
    // Run the generated module under Node and verify path matching.
    const src = generateRouter({
      routes: [
        {
          host: null,
          paths: [
            { path: '/api', pathType: 'Prefix', backendBinding: 'api' },
            { path: '/', pathType: 'Prefix', backendBinding: 'root' },
          ],
        },
      ],
      defaultBackend: null,
    });
    interface Stub {
      fetch: (req: Request) => Promise<Response>;
    }
    const stub = (id: string): Stub => ({
      fetch: async (req: Request) => new Response(`hit:${id}:${new URL(req.url).pathname}`),
    });
    const env: Record<string, Stub> = { api: stub('api'), root: stub('root') };
    const dataUrl = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
    const mod = (await import(dataUrl)) as {
      default: { fetch: (req: Request, env: Record<string, Stub>) => Promise<Response> };
    };
    const fetch = (path: string) =>
      mod.default
        .fetch(new Request(`https://example.com${path}`), env)
        .then((r) => r.text());
    expect(await fetch('/api')).toBe('hit:api:/api');
    expect(await fetch('/api/users')).toBe('hit:api:/api/users');
    // `/apifoo` must NOT match `/api` (k8s Prefix is segment-wise)
    expect(await fetch('/apifoo')).toBe('hit:root:/apifoo');
    expect(await fetch('/anything')).toBe('hit:root:/anything');
  });
});
