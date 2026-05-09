import * as k8s from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

/**
 * Leader election via a `coordination.k8s.io/v1` Lease, modelled after
 * controller-runtime's algorithm:
 *
 *   1. GET the Lease. If absent, CREATE it with ourselves as holder.
 *   2. If the holder is us OR the lease has expired
 *      (renewTime + leaseDurationSeconds < now), PATCH it to claim/renew.
 *      Use resourceVersion for optimistic concurrency — a 409 means
 *      another candidate raced us; back off and retry next tick.
 *   3. Otherwise, we're a follower; sleep `retryPeriodSec` and re-check.
 *
 * The `onAcquire` callback fires once when we transition follower →
 * leader. The `onLose` callback fires when we transition leader →
 * follower (lease was taken from us, or we couldn't renew).
 */
export interface LeaderElectionOptions {
  readonly kc: k8s.KubeConfig;
  readonly leaseName: string;
  readonly leaseNamespace: string;
  readonly identity?: string;
  /** Total time a lease is valid after the last successful renew. */
  readonly leaseDurationSec?: number;
  /** Interval between renew attempts while we hold the lease. */
  readonly renewIntervalSec?: number;
  /** Interval between acquire attempts while we don't hold the lease. */
  readonly retryPeriodSec?: number;
  readonly onAcquire: () => Promise<void> | void;
  readonly onLose: () => Promise<void> | void;
  readonly onWarning?: (msg: string) => void;
  readonly signal: AbortSignal;
}

const DEFAULTS = {
  leaseDurationSec: 15,
  renewIntervalSec: 5,
  retryPeriodSec: 2,
};

export async function runLeaderElection(options: LeaderElectionOptions): Promise<void> {
  const onWarning = options.onWarning ?? ((m) => console.warn(m));
  const identity = options.identity ?? defaultIdentity();
  const leaseDurationSec = options.leaseDurationSec ?? DEFAULTS.leaseDurationSec;
  const renewIntervalSec = options.renewIntervalSec ?? DEFAULTS.renewIntervalSec;
  const retryPeriodSec = options.retryPeriodSec ?? DEFAULTS.retryPeriodSec;
  const api = options.kc.makeApiClient(k8s.CoordinationV1Api);

  let isLeader = false;

  while (!options.signal.aborted) {
    let lease: { resourceVersion?: string; holderIdentity?: string; renewTime?: string } | undefined;
    try {
      const got = (await api.readNamespacedLease({
        namespace: options.leaseNamespace,
        name: options.leaseName,
      })) as {
        metadata?: { resourceVersion?: string };
        spec?: { holderIdentity?: string; renewTime?: string };
      };
      lease = {
        ...(got.metadata?.resourceVersion ? { resourceVersion: got.metadata.resourceVersion } : {}),
        ...(got.spec?.holderIdentity ? { holderIdentity: got.spec.holderIdentity } : {}),
        ...(got.spec?.renewTime ? { renewTime: got.spec.renewTime } : {}),
      };
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 404) {
        onWarning(`leader: read lease failed: ${(e as Error).message ?? e}`);
        await sleep(retryPeriodSec * 1000, options.signal);
        continue;
      }
      // Lease missing — try to create it.
      try {
        await api.createNamespacedLease({
          namespace: options.leaseNamespace,
          body: buildLease(options.leaseName, options.leaseNamespace, identity, leaseDurationSec),
        });
        isLeader = await transitionTo(true, isLeader, options);
      } catch (createErr) {
        const c = (createErr as { code?: number }).code;
        if (c !== 409) {
          onWarning(`leader: create lease failed: ${(createErr as Error).message ?? createErr}`);
        }
      }
      await sleep((isLeader ? renewIntervalSec : retryPeriodSec) * 1000, options.signal);
      continue;
    }

    const expired = lease.renewTime
      ? Date.parse(lease.renewTime) + leaseDurationSec * 1000 < Date.now()
      : true;
    const heldByUs = lease.holderIdentity === identity;
    if (heldByUs || expired) {
      try {
        await api.replaceNamespacedLease({
          namespace: options.leaseNamespace,
          name: options.leaseName,
          body: buildLease(
            options.leaseName,
            options.leaseNamespace,
            identity,
            leaseDurationSec,
            lease.resourceVersion,
          ),
        });
        isLeader = await transitionTo(true, isLeader, options);
      } catch (patchErr) {
        const c = (patchErr as { code?: number }).code;
        if (c === 409) {
          // Another candidate beat us. Drop leadership and retry.
          isLeader = await transitionTo(false, isLeader, options);
        } else {
          onWarning(`leader: renew failed: ${(patchErr as Error).message ?? patchErr}`);
          isLeader = await transitionTo(false, isLeader, options);
        }
      }
    } else {
      // Lease held by someone else and still valid — we're a follower.
      isLeader = await transitionTo(false, isLeader, options);
    }
    await sleep((isLeader ? renewIntervalSec : retryPeriodSec) * 1000, options.signal);
  }
  // Clean shutdown: drop leadership claim if we held it.
  if (isLeader) await Promise.resolve(options.onLose());
}

async function transitionTo(
  desired: boolean,
  current: boolean,
  options: LeaderElectionOptions,
): Promise<boolean> {
  if (desired === current) return current;
  if (desired) await Promise.resolve(options.onAcquire());
  else await Promise.resolve(options.onLose());
  return desired;
}

function buildLease(
  name: string,
  namespace: string,
  identity: string,
  leaseDurationSec: number,
  resourceVersion?: string,
): k8s.V1Lease {
  // V1MicroTime extends Date in @kubernetes/client-node — we serialise
  // through the SDK so a plain Date works at runtime; cast at the
  // boundary to satisfy the (over-narrow) generated type.
  const now = new k8s.V1MicroTime();
  const body: k8s.V1Lease = {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name,
      namespace,
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    spec: {
      holderIdentity: identity,
      leaseDurationSeconds: leaseDurationSec,
      acquireTime: now,
      renewTime: now,
    },
  };
  return body;
}

export function defaultIdentity(): string {
  // POD_NAME is set by the kubelet via the downward API; fallback to
  // hostname + UUID so local runs are still distinguishable.
  return process.env['POD_NAME'] ?? `${os.hostname()}-${randomUUID()}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
