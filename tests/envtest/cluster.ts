import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Spawn a local etcd + kube-apiserver pair using the envtest binaries
 * fetched by `scripts/setup-envtest.mjs`. The pair behaves like a real
 * Kubernetes API surface: CRDs register, CRs persist, watches fire —
 * but there is no kubelet, no scheduler, no controller-manager. Pods
 * created against this apiserver sit forever in Pending. That is
 * exactly what k1c wants for testing its CRD lower / reconcile logic.
 *
 * Auth is intentionally permissive: `--authorization-mode=AlwaysAllow`
 * + anonymous user, no client cert. This is a test-only cluster bound
 * to 127.0.0.1, and we want every test to talk to it without juggling
 * tokens or kubeconfig contexts.
 */

const VERSION = process.env['ENVTEST_K8S_VERSION'] ?? '1.36.0';
const BIN_DIR = join(process.cwd(), 'node_modules', '.cache', 'envtest', `v${VERSION}`);

export interface EnvtestCluster {
  readonly kubeconfigPath: string;
  readonly apiServerUrl: string;
  readonly stop: () => Promise<void>;
}

export async function startCluster(): Promise<EnvtestCluster> {
  const tmp = mkdtempSync(join(tmpdir(), 'k1c-envtest-'));
  const etcdDataDir = join(tmp, 'etcd-data');
  const certDir = join(tmp, 'certs');
  mkdirSync(certDir, { recursive: true });

  // The apiserver requires a key pair to sign service-account tokens.
  // We don't care about the keys' identity, only that they're valid
  // RSA and that the public half matches what we hand to
  // --service-account-key-file.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saKeyPath = join(certDir, 'sa.key');
  const saPubPath = join(certDir, 'sa.pub');
  writeFileSync(saKeyPath, privateKey.export({ format: 'pem', type: 'pkcs1' }) as string);
  writeFileSync(saPubPath, publicKey.export({ format: 'pem', type: 'spki' }) as string);

  // k8s 1.36 rejects `AlwaysAllow` + anonymous auth. Use a static
  // token mapped to the `system:masters` group instead — RBAC short-
  // circuits this group as super-user without any extra bindings.
  const token = randomBytes(24).toString('hex');
  const tokenFile = join(certDir, 'tokens.csv');
  writeFileSync(tokenFile, `${token},envtest-admin,uid-envtest,"system:masters"\n`);

  const etcdPort = await getFreePort();
  const etcdPeerPort = await getFreePort();
  const apiPort = await getFreePort();

  const etcd = spawn(
    join(BIN_DIR, 'etcd'),
    [
      `--listen-client-urls=http://127.0.0.1:${etcdPort}`,
      `--advertise-client-urls=http://127.0.0.1:${etcdPort}`,
      `--listen-peer-urls=http://127.0.0.1:${etcdPeerPort}`,
      `--data-dir=${etcdDataDir}`,
      // Tests run inside a single tmpdir with no replication, so
      // fsync per write only slows the suite down — disable it.
      '--unsafe-no-fsync=true',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  etcd.on('error', (e) => console.error(`[envtest] etcd error: ${e.message}`));
  if (process.env['ENVTEST_DEBUG'] === '1') {
    etcd.stderr?.on('data', (b) => process.stderr.write(`[etcd] ${b}`));
    etcd.stdout?.on('data', (b) => process.stderr.write(`[etcd] ${b}`));
  }

  await waitFor(
    async () => {
      const r = await fetch(`http://127.0.0.1:${etcdPort}/health`).catch(() => null);
      return r !== null && r.ok;
    },
    { timeoutMs: 15_000, intervalMs: 200, label: 'etcd /health' },
  );

  const apiserver = spawn(
    join(BIN_DIR, 'kube-apiserver'),
    [
      '--advertise-address=127.0.0.1',
      `--etcd-servers=http://127.0.0.1:${etcdPort}`,
      `--cert-dir=${certDir}`,
      `--secure-port=${apiPort}`,
      '--bind-address=127.0.0.1',
      '--service-cluster-ip-range=10.0.0.0/24',
      '--allow-privileged=true',
      // RBAC short-circuits the `system:masters` group as super-user,
      // so the static token below is all the auth we need.
      '--authorization-mode=RBAC',
      `--token-auth-file=${tokenFile}`,
      // ServiceAccount admission would try to mount a token into every
      // created Pod, which fails without a controller-manager.
      '--disable-admission-plugins=ServiceAccount',
      '--service-account-issuer=https://localhost/',
      `--service-account-key-file=${saPubPath}`,
      `--service-account-signing-key-file=${saKeyPath}`,
      '--api-audiences=k1c-envtest',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  apiserver.on('error', (e) => console.error(`[envtest] apiserver error: ${e.message}`));
  if (process.env['ENVTEST_DEBUG'] === '1') {
    apiserver.stderr?.on('data', (b) => process.stderr.write(`[apiserver] ${b}`));
    apiserver.stdout?.on('data', (b) => process.stderr.write(`[apiserver] ${b}`));
  }
  apiserver.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`[envtest] apiserver exited early code=${code} sig=${sig}`);
    }
  });

  const kubeconfigPath = join(tmp, 'kubeconfig');
  const apiServerUrl = `https://127.0.0.1:${apiPort}`;
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster:',
      `    server: ${apiServerUrl}`,
      '    insecure-skip-tls-verify: true',
      '  name: envtest',
      'contexts:',
      '- context:',
      '    cluster: envtest',
      '    user: envtest',
      '  name: envtest',
      'current-context: envtest',
      'users:',
      '- name: envtest',
      '  user:',
      `    token: ${token}`,
      '',
    ].join('\n'),
  );

  await waitFor(
    async () => {
      const code = await runKubectl(kubeconfigPath, ['get', '--raw=/readyz']);
      return code === 0;
    },
    { timeoutMs: 30_000, intervalMs: 300, label: 'kube-apiserver /readyz' },
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopProcess(apiserver);
    await stopProcess(etcd);
    rmSync(tmp, { recursive: true, force: true });
  };

  return { kubeconfigPath, apiServerUrl, stop };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      if (a !== null && typeof a === 'object') {
        const port = a.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('failed to allocate port'));
      }
    });
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(opts.intervalMs);
  }
  throw new Error(
    `${opts.label} not ready after ${opts.timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ''}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runKubectl(kubeconfigPath: string, args: ReadonlyArray<string>): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(join(BIN_DIR, 'kubectl'), [`--kubeconfig=${kubeconfigPath}`, ...args], {
      stdio: 'ignore',
    });
    proc.on('exit', (code) => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });
}

function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5000);
  });
}
