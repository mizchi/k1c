/**
 * Generates the JavaScript source for a k1c Ingress router Worker.
 *
 * The router holds the Ingress routing table inline as a frozen literal and
 * dispatches each request to the matching backend Worker via a `service`
 * binding. Host matching supports k8s-style wildcards (`*.example.com`).
 * Path matching follows k8s Ingress semantics: `Prefix` matches segment-wise
 * (`/foo` matches `/foo` and `/foo/bar` but not `/foobar`), `Exact` requires
 * full equality, `ImplementationSpecific` is treated as `Prefix`.
 */

export interface RouterRoute {
  /**
   * Hostname rule. Either a literal host (`api.example.com`), a wildcard
   * (`*.example.com`), or null for the catch-all rule (`spec.rules[].host` omitted).
   */
  readonly host: string | null;
  readonly paths: ReadonlyArray<RouterPath>;
}

export interface RouterPath {
  readonly path: string;
  readonly pathType: 'Prefix' | 'Exact' | 'ImplementationSpecific';
  /** Binding identifier on `env` (e.g. `b0`, `b1`, ...) referencing the backend Worker. */
  readonly backendBinding: string;
}

export interface RouterTemplateOptions {
  readonly routes: ReadonlyArray<RouterRoute>;
  readonly defaultBackend: string | null;
}

export function generateRouter(opts: RouterTemplateOptions): string {
  const tableLiteral = JSON.stringify(opts.routes, null, 2);
  const defaultLiteral = opts.defaultBackend === null ? 'null' : JSON.stringify(opts.defaultBackend);
  return `// k1c Ingress router (generated)
const ROUTES = ${tableLiteral};
const DEFAULT = ${defaultLiteral};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.host).toLowerCase();
    const path = url.pathname;

    for (const rule of ROUTES) {
      if (!matchHost(rule.host, host)) continue;
      for (const p of rule.paths) {
        if (matchPath(p, path)) return env[p.backendBinding].fetch(request);
      }
    }
    if (DEFAULT !== null) return env[DEFAULT].fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};

function matchHost(rule, host) {
  if (rule === null) return true;
  const r = rule.toLowerCase();
  if (r.startsWith('*.')) return host.endsWith(r.slice(1));
  return host === r;
}

function matchPath(p, path) {
  if (p.pathType === 'Exact') return path === p.path;
  if (p.path === '/') return true;
  if (path === p.path) return true;
  return path.startsWith(p.path + '/');
}
`;
}
