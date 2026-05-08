import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  ConfigMapResource,
  Deployment,
  DispatchNamespace,
  K1cResource,
  KVNamespace,
  ObjectMeta,
  PodTemplateSpec,
  R2Bucket,
  ResourceRef,
  Rollout,
  SecretResource,
  ServiceResource,
} from './types.ts';
import type { DesiredResource } from '../reconciler/types.ts';
import type { WorkerBinding, WorkerProperties } from '../providers/worker.ts';
import type { R2BucketProperties } from '../providers/r2-bucket.ts';
import type { KVNamespaceProperties } from '../providers/kv-namespace.ts';
import type { DispatchNamespaceProperties } from '../providers/dispatch-namespace.ts';
import type { CustomDomainProperties } from '../providers/custom-domain.ts';
import { generateDispatcher } from '../canary/dispatcher-template.ts';

export class LowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LowerError';
  }
}

export interface LowerWarning {
  readonly ref: ResourceRef;
  readonly message: string;
}

export interface LowerResult {
  readonly desired: ReadonlyArray<DesiredResource>;
  readonly warnings: ReadonlyArray<LowerWarning>;
}

export interface LowerOptions {
  /**
   * Reads the bytes of a Worker entrypoint file. Defaults to fs/promises.readFile.
   * Tests inject a stub to keep lower decoupled from disk I/O.
   */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

const DEFAULT_COMPATIBILITY_DATE = '2025-01-01';

interface LookupTables {
  readonly configMaps: Map<string, ConfigMapResource>;
  readonly secrets: Map<string, SecretResource>;
  readonly r2Buckets: Map<string, R2Bucket>;
  readonly kvNamespaces: Map<string, KVNamespace>;
}

export async function lower(
  resources: ReadonlyArray<K1cResource>,
  options?: LowerOptions,
): Promise<LowerResult> {
  const tables: LookupTables = {
    configMaps: new Map(),
    secrets: new Map(),
    r2Buckets: new Map(),
    kvNamespaces: new Map(),
  };
  const deployments: Deployment[] = [];
  const rollouts: Rollout[] = [];
  const dispatchNamespaces: DispatchNamespace[] = [];
  const services: ServiceResource[] = [];

  for (const r of resources) {
    const label = labelOf(r);
    switch (r.kind) {
      case 'Namespace':
        break;
      case 'ConfigMap':
        tables.configMaps.set(label, r);
        break;
      case 'Secret':
        tables.secrets.set(label, r);
        break;
      case 'R2Bucket':
        tables.r2Buckets.set(label, r);
        break;
      case 'KVNamespace':
        tables.kvNamespaces.set(label, r);
        break;
      case 'DispatchNamespace':
        dispatchNamespaces.push(r);
        break;
      case 'Service':
        services.push(r);
        break;
      case 'Deployment':
        deployments.push(r);
        break;
      case 'Rollout':
        rollouts.push(r);
        break;
    }
  }

  const desired: DesiredResource[] = [];
  const warnings: LowerWarning[] = [];

  for (const b of tables.r2Buckets.values()) desired.push(lowerR2Bucket(b));
  for (const kv of tables.kvNamespaces.values()) desired.push(lowerKVNamespace(kv));
  for (const dn of dispatchNamespaces) desired.push(lowerDispatchNamespace(dn));
  for (const d of deployments) desired.push(await lowerDeployment(d, tables, options));

  const emittedStateKvs = new Set<string>();
  for (const r of rollouts) {
    for (const d of await lowerRollout(r, tables, warnings, emittedStateKvs, options)) {
      desired.push(d);
    }
  }

  for (const s of services) {
    const out = lowerService(s, deployments, rollouts, warnings);
    if (out !== null) desired.push(out);
  }

  return { desired, warnings };
}

function lowerService(
  s: ServiceResource,
  deployments: ReadonlyArray<Deployment>,
  rollouts: ReadonlyArray<Rollout>,
  warnings: LowerWarning[],
): DesiredResource<CustomDomainProperties> | null {
  const ns = s.metadata.namespace ?? 'default';
  const name = s.metadata.name;
  const ref = refOf(s);
  const type = s.spec.type ?? 'ClusterIP';

  if (type === 'ClusterIP') {
    warnings.push({
      ref,
      message: `Service ${ns}/${name}: type=ClusterIP is not yet implemented (v0.1.5); the Worker can be referenced as a service binding once support lands`,
    });
    return null;
  }

  const annotations = s.metadata.annotations ?? {};
  const zoneId = annotations['cloudflare.com/zone-id'];
  const hostname = annotations['cloudflare.com/hostname'];
  if (!zoneId || !hostname) {
    throw new LowerError(
      `Service ${ns}/${name}: type=LoadBalancer requires both \`cloudflare.com/zone-id\` and \`cloudflare.com/hostname\` annotations`,
    );
  }

  // Match the selector against Deployment / Rollout in the same namespace.
  const target = findWorkloadBySelector(s.spec.selector, ns, deployments, rollouts);
  if (target === null) {
    throw new LowerError(
      `Service ${ns}/${name}: no Deployment or Rollout in namespace "${ns}" matches selector ${JSON.stringify(s.spec.selector)}`,
    );
  }

  const targetScriptName = `k1c--${ns}--${target.name}`;
  return {
    resourceType: 'CustomDomain',
    ref,
    label: hostname,
    properties: {
      hostname,
      service: targetScriptName,
      zoneId,
      environment: annotations['cloudflare.com/environment'] ?? 'production',
    },
    dependsOn: [
      {
        apiVersion: target.apiVersion,
        kind: target.kind,
        namespace: ns,
        name: target.name,
      },
    ],
  };
}

interface SelectorMatch {
  readonly apiVersion: string;
  readonly kind: 'Deployment' | 'Rollout';
  readonly name: string;
}

function findWorkloadBySelector(
  selector: Readonly<Record<string, string>>,
  namespace: string,
  deployments: ReadonlyArray<Deployment>,
  rollouts: ReadonlyArray<Rollout>,
): SelectorMatch | null {
  for (const d of deployments) {
    if ((d.metadata.namespace ?? 'default') !== namespace) continue;
    if (isSubset(selector, d.spec.selector.matchLabels)) {
      return { apiVersion: d.apiVersion, kind: 'Deployment', name: d.metadata.name };
    }
  }
  for (const r of rollouts) {
    if ((r.metadata.namespace ?? 'default') !== namespace) continue;
    if (isSubset(selector, r.spec.selector.matchLabels)) {
      return { apiVersion: r.apiVersion, kind: 'Rollout', name: r.metadata.name };
    }
  }
  return null;
}

function isSubset(
  small: Readonly<Record<string, string>>,
  large: Readonly<Record<string, string>>,
): boolean {
  for (const [k, v] of Object.entries(small)) {
    if (large[k] !== v) return false;
  }
  return true;
}

async function defaultReadFile(path: string): Promise<Uint8Array> {
  const fs = await import('node:fs/promises');
  return fs.readFile(path);
}

async function hashEntrypoint(
  props: WorkerProperties,
  options: LowerOptions | undefined,
): Promise<string> {
  let bytes: Uint8Array;
  if (props.entrypointContent !== undefined) {
    bytes = new TextEncoder().encode(props.entrypointContent);
  } else {
    const reader = options?.readFile ?? defaultReadFile;
    bytes = await reader(props.entrypoint);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function lowerDispatchNamespace(
  dn: DispatchNamespace,
): DesiredResource<DispatchNamespaceProperties> {
  const ns = dn.metadata.namespace ?? 'default';
  const name = dn.metadata.name;
  return {
    resourceType: 'DispatchNamespace',
    ref: refOf(dn),
    label: `${ns}/${name}`,
    properties: { namespaceName: `k1c-${ns}-${name}` },
  };
}

function labelOf(r: K1cResource): string {
  return `${r.metadata.namespace ?? 'default'}/${r.metadata.name}`;
}

function refOf(r: K1cResource): ResourceRef {
  return {
    apiVersion: r.apiVersion,
    kind: r.kind,
    namespace: r.metadata.namespace ?? 'default',
    name: r.metadata.name,
  };
}

function lowerR2Bucket(b: R2Bucket): DesiredResource<R2BucketProperties> {
  const ns = b.metadata.namespace ?? 'default';
  const name = b.metadata.name;
  const properties: R2BucketProperties = {
    bucketName: `k1c-${ns}-${name}`,
    ...(b.spec.location !== undefined ? { location: b.spec.location } : {}),
    ...(b.spec.storageClass !== undefined ? { storageClass: b.spec.storageClass } : {}),
  };
  return {
    resourceType: 'R2Bucket',
    ref: refOf(b),
    label: `${ns}/${name}`,
    properties,
  };
}

function lowerKVNamespace(kv: KVNamespace): DesiredResource<KVNamespaceProperties> {
  const ns = kv.metadata.namespace ?? 'default';
  const name = kv.metadata.name;
  return {
    resourceType: 'KVNamespace',
    ref: refOf(kv),
    label: `${ns}/${name}`,
    properties: { title: kv.spec.title ?? `k1c/${ns}/${name}` },
  };
}

async function lowerDeployment(
  d: Deployment,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<DesiredResource<WorkerProperties>> {
  return buildWorkerDesired('Deployment', refOf(d), d.metadata, d.spec.template, tables, options);
}

async function lowerRollout(
  r: Rollout,
  tables: LookupTables,
  warnings: LowerWarning[],
  emittedStateKvs: Set<string>,
  options: LowerOptions | undefined,
): Promise<ReadonlyArray<DesiredResource>> {
  const ns = r.metadata.namespace ?? 'default';
  const name = r.metadata.name;
  const ref = refOf(r);
  const annotations = r.metadata.annotations ?? {};
  const dispatchAnno = annotations['cloudflare.com/dispatch-namespace'];

  if (dispatchAnno !== undefined) {
    return lowerCanaryRollout(r, dispatchAnno, tables, warnings, emittedStateKvs, options);
  }

  if ('canary' in r.spec.strategy) {
    warnings.push({
      ref,
      message: `Rollout ${ns}/${name}: canary strategy is not yet implemented in v0.1; deploying new version at 100% (treating as immediate cutover)`,
    });
  } else {
    const bg = r.spec.strategy.blueGreen;
    if (bg.autoPromotionEnabled === false) {
      warnings.push({
        ref,
        message: `Rollout ${ns}/${name}: blueGreen with autoPromotionEnabled=false is not yet implemented in v0.1; deploying new version at 100%`,
      });
    }
  }
  return [
    await buildWorkerDesired('Rollout', ref, r.metadata, r.spec.template, tables, options),
  ];
}

async function lowerCanaryRollout(
  r: Rollout,
  dispatchAnno: string,
  tables: LookupTables,
  warnings: LowerWarning[],
  emittedStateKvs: Set<string>,
  options: LowerOptions | undefined,
): Promise<ReadonlyArray<DesiredResource>> {
  const ns = r.metadata.namespace ?? 'default';
  const name = r.metadata.name;
  const ref = refOf(r);
  const dispatchNsCFName = `k1c-${ns}-${dispatchAnno}`;
  const stableScriptName = `k1c--${ns}--${name}--stable`;
  const canaryScriptName = `k1c--${ns}--${name}--canary`;
  const dispatcherScriptName = `k1c--${ns}--${name}`;
  const stateKvK8sName = `rollout-state-${dispatchAnno}`;
  const stateKvCFTitle = `k1c/rollout-state/${dispatchAnno}`;

  const dispatchNsRef: ResourceRef = {
    apiVersion: 'cloudflare.k1c.io/v1alpha1',
    kind: 'DispatchNamespace',
    namespace: ns,
    name: dispatchAnno,
  };
  const stateKvRef: ResourceRef = {
    apiVersion: 'cloudflare.k1c.io/v1alpha1',
    kind: 'KVNamespace',
    namespace: ns,
    name: stateKvK8sName,
  };

  const results: DesiredResource[] = [];

  // Auto-emit the rollout-state KV (shared across all rollouts in the same dispatch namespace).
  if (!emittedStateKvs.has(stateKvCFTitle)) {
    emittedStateKvs.add(stateKvCFTitle);
    results.push({
      resourceType: 'KVNamespace',
      ref: stateKvRef,
      label: `${ns}/${stateKvK8sName}`,
      properties: { title: stateKvCFTitle },
    });
  }

  // Stable Worker = the user's code, deployed into the dispatch namespace under <name>--stable.
  const userWorker = await buildWorkerDesired(
    'Rollout',
    ref,
    r.metadata,
    r.spec.template,
    tables,
    options,
  );
  const stableRef: ResourceRef = { ...ref, name: `${name}--stable` };
  const stableProperties: WorkerProperties = {
    ...userWorker.properties,
    scriptName: stableScriptName,
    dispatchNamespace: dispatchNsCFName,
  };
  const stableDeps: ResourceRef[] = [...(userWorker.dependsOn ?? []), dispatchNsRef];
  results.push({
    resourceType: 'Worker',
    ref: stableRef,
    label: `${ns}/${name}--stable`,
    properties: stableProperties,
    dependsOn: stableDeps,
  });

  // Dispatcher Worker = generated by k1c, deployed top-level. Routes via env.NAMESPACE.get(...)
  // based on the weight stored in env.STATE under the rollout key.
  const dispatcherSource = generateDispatcher({
    rolloutKey: `rollout/${ns}/${name}`,
    stableName: stableScriptName,
    canaryName: canaryScriptName,
  });
  const dispatcherBaseProperties: WorkerProperties = {
    scriptName: dispatcherScriptName,
    entrypoint: '<k1c-generated:dispatcher>',
    entrypointContent: dispatcherSource,
    compatibilityDate:
      r.metadata.annotations?.['cloudflare.com/compatibility-date'] ??
      DEFAULT_COMPATIBILITY_DATE,
    bindings: [
      { type: 'dispatch_namespace', name: 'NAMESPACE', dispatchNamespace: dispatchNsCFName },
      { type: 'kv_namespace', name: 'STATE', namespaceId: `<resolved-at-apply:${stateKvK8sName}>` },
    ],
  };
  const dispatcherProperties: WorkerProperties = {
    ...dispatcherBaseProperties,
    entrypointHash: await hashEntrypoint(dispatcherBaseProperties, options),
  };
  results.push({
    resourceType: 'Worker',
    ref,
    label: `${ns}/${name}`,
    properties: dispatcherProperties,
    dependsOn: [dispatchNsRef, stateKvRef, stableRef],
  });

  // Note: the canary script itself is not emitted at lower time — its lifecycle (create
  // / update / delete) is owned by the v0.1.2-ε state machine on apply, which compares
  // current code against the stored "stable hash" to decide when to spawn a candidate.
  if ('canary' in r.spec.strategy) {
    warnings.push({
      ref,
      message: `Rollout ${ns}/${name}: canary state machine is not yet implemented (v0.1.2-ε); dispatcher routes 100% to stable until rollout-state KV is populated`,
    });
  } else if (r.spec.strategy.blueGreen.autoPromotionEnabled === false) {
    warnings.push({
      ref,
      message: `Rollout ${ns}/${name}: manual blueGreen promotion is not yet implemented; dispatcher routes 100% to stable`,
    });
  }
  return results;
}

async function buildWorkerDesired(
  kind: 'Deployment' | 'Rollout',
  ref: ResourceRef,
  meta: ObjectMeta,
  template: PodTemplateSpec,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<DesiredResource<WorkerProperties>> {
  const ns = meta.namespace ?? 'default';
  const name = meta.name;
  const annotations = meta.annotations ?? {};

  const containers = template.spec.containers;
  if (containers.length !== 1) {
    throw new LowerError(
      `${kind} ${ns}/${name}: only single-container Pods are supported in v0 (got ${containers.length})`,
    );
  }
  const container = containers[0]!;

  const dependsOn: ResourceRef[] = [];
  const vars: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const env of container.env ?? []) {
    if (env.value !== undefined) {
      vars[env.name] = env.value;
      continue;
    }
    const valueFrom = env.valueFrom;
    if (!valueFrom) {
      throw new LowerError(
        `${kind} ${ns}/${name}: env "${env.name}" has neither value nor valueFrom`,
      );
    }
    if (valueFrom.configMapKeyRef) {
      const cmRef = valueFrom.configMapKeyRef;
      const cm = tables.configMaps.get(`${ns}/${cmRef.name}`);
      if (!cm) {
        throw new LowerError(
          `${kind} ${ns}/${name}: ConfigMap "${cmRef.name}" not found in namespace "${ns}" (env ${env.name})`,
        );
      }
      const value = cm.data?.[cmRef.key];
      if (value === undefined) {
        throw new LowerError(
          `${kind} ${ns}/${name}: ConfigMap "${cmRef.name}" has no key "${cmRef.key}"`,
        );
      }
      vars[env.name] = value;
      pushUnique(dependsOn, refOf(cm));
    } else if (valueFrom.secretKeyRef) {
      const sRef = valueFrom.secretKeyRef;
      const sec = tables.secrets.get(`${ns}/${sRef.name}`);
      if (!sec) {
        throw new LowerError(
          `${kind} ${ns}/${name}: Secret "${sRef.name}" not found in namespace "${ns}" (env ${env.name})`,
        );
      }
      const value = secretValue(sec, sRef.key);
      if (value === undefined) {
        throw new LowerError(
          `${kind} ${ns}/${name}: Secret "${sRef.name}" has no key "${sRef.key}"`,
        );
      }
      secrets[env.name] = value;
      pushUnique(dependsOn, refOf(sec));
    } else {
      throw new LowerError(
        `${kind} ${ns}/${name}: env "${env.name}" valueFrom must specify configMapKeyRef or secretKeyRef`,
      );
    }
  }

  const bindings: WorkerBinding[] = [];
  const volumes = template.spec.volumes ?? [];
  const volumesByName = new Map(volumes.map((v) => [v.name, v]));
  for (const mount of container.volumeMounts ?? []) {
    const vol = volumesByName.get(mount.name);
    if (!vol) {
      throw new LowerError(
        `${kind} ${ns}/${name}: volumeMount "${mount.name}" has no matching volume`,
      );
    }
    if (vol.r2BucketRef) {
      const b = tables.r2Buckets.get(`${ns}/${vol.r2BucketRef.name}`);
      if (!b) {
        throw new LowerError(
          `${kind} ${ns}/${name}: R2Bucket "${vol.r2BucketRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'r2_bucket',
        name: mount.mountPath,
        bucketName: `k1c-${ns}-${b.metadata.name}`,
      });
      pushUnique(dependsOn, refOf(b));
    } else if (vol.kvNamespaceRef) {
      const kv = tables.kvNamespaces.get(`${ns}/${vol.kvNamespaceRef.name}`);
      if (!kv) {
        throw new LowerError(
          `${kind} ${ns}/${name}: KVNamespace "${vol.kvNamespaceRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'kv_namespace',
        name: mount.mountPath,
        namespaceId: `<resolved-at-apply:${kv.metadata.name}>`,
      });
      pushUnique(dependsOn, refOf(kv));
    } else {
      throw new LowerError(
        `${kind} ${ns}/${name}: volume "${vol.name}" has no recognised reference (r2BucketRef or kvNamespaceRef)`,
      );
    }
  }

  const flagsAnno = annotations['cloudflare.com/compatibility-flags'];
  const flags = flagsAnno
    ? flagsAnno
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  const baseProperties: WorkerProperties = {
    scriptName: `k1c--${ns}--${name}`,
    entrypoint: container.image,
    compatibilityDate:
      annotations['cloudflare.com/compatibility-date'] ?? DEFAULT_COMPATIBILITY_DATE,
    ...(flags !== undefined ? { compatibilityFlags: flags } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    ...(bindings.length > 0 ? { bindings } : {}),
    ...(annotations['cloudflare.com/observability'] === 'enabled'
      ? { observability: { enabled: true } }
      : {}),
    ...(annotations['cloudflare.com/smart-placement'] === 'smart'
      ? { placement: { mode: 'smart' as const } }
      : {}),
  };

  const properties: WorkerProperties = {
    ...baseProperties,
    entrypointHash: await hashEntrypoint(baseProperties, options),
  };

  return {
    resourceType: 'Worker',
    ref,
    label: `${ns}/${name}`,
    properties,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function secretValue(sec: SecretResource, key: string): string | undefined {
  const fromString = sec.stringData?.[key];
  if (fromString !== undefined) return fromString;
  const fromData = sec.data?.[key];
  if (fromData !== undefined) return Buffer.from(fromData, 'base64').toString('utf-8');
  return undefined;
}

function pushUnique(list: ResourceRef[], ref: ResourceRef): void {
  for (const existing of list) {
    if (
      existing.apiVersion === ref.apiVersion &&
      existing.kind === ref.kind &&
      existing.namespace === ref.namespace &&
      existing.name === ref.name
    ) {
      return;
    }
  }
  list.push(ref);
}
