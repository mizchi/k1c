import http from 'node:http';
import { renderMetrics } from './metrics.ts';

export interface MetricsServerOptions {
  /** "host:port" — pass `0.0.0.0:9090` for kubelet scrape, `127.0.0.1:9090` for local. */
  readonly addr: string;
  /**
   * Returns true once the operator has completed its first reconcile
   * pass. /readyz responds 200 when this is true, 503 otherwise.
   */
  readonly isReady: () => boolean;
  readonly signal: AbortSignal;
  readonly onWarning?: (msg: string) => void;
}

/**
 * Tiny HTTP server exposing /metrics, /healthz, /readyz. Kept off the
 * main hot path — failures here never crash the operator.
 */
export function startMetricsServer(options: MetricsServerOptions): http.Server {
  const onWarning = options.onWarning ?? ((m) => console.warn(m));
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/metrics') {
      const body = renderMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url === '/readyz') {
      const ready = options.isReady();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(ready ? 'ready' : 'not ready');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const [host, portStr] = parseAddr(options.addr);
  const port = Number.parseInt(portStr, 10);
  server.on('error', (e) => onWarning(`metrics server: ${e.message}`));
  server.listen(port, host);

  options.signal.addEventListener('abort', () => server.close(), { once: true });

  return server;
}

function parseAddr(addr: string): [string, string] {
  // Accept "host:port" / ":port" / just "port".
  const colon = addr.lastIndexOf(':');
  if (colon < 0) return ['0.0.0.0', addr];
  const host = addr.slice(0, colon);
  const port = addr.slice(colon + 1);
  return [host === '' ? '0.0.0.0' : host, port];
}
