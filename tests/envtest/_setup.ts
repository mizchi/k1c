import { startCluster, type EnvtestCluster } from './cluster.ts';

/**
 * vitest `globalSetup` entry point. Brings up a single envtest
 * apiserver per test run and exports its kubeconfig path via the
 * `KUBECONFIG` env var so every test can simply call
 * `kc.loadFromDefault()`. Returns a teardown thunk that vitest invokes
 * after the last suite resolves.
 */
let cluster: EnvtestCluster | null = null;

export async function setup(): Promise<void> {
  cluster = await startCluster();
  process.env['KUBECONFIG'] = cluster.kubeconfigPath;
  process.env['K1C_ENVTEST_APISERVER'] = cluster.apiServerUrl;
}

export async function teardown(): Promise<void> {
  if (cluster !== null) {
    await cluster.stop();
    cluster = null;
  }
}
