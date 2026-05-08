import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  ConfigMapResource,
  CronJob,
  D1Database,
  Deployment,
  DispatchNamespace,
  DNSRecord,
  Hyperdrive,
  Job,
  K1cResource,
  KVNamespace,
  ObjectMeta,
  PodTemplateSpec,
  Queue,
  R2Bucket,
  ResourceRef,
  Rollout,
  SecretResource,
  ServiceResource,
  StatefulSet,
  Vectorize,
} from './types.ts';
import type { DesiredResource } from '../reconciler/types.ts';
import type { WorkerBinding, WorkerProperties } from '../providers/worker.ts';
import type { R2BucketProperties } from '../providers/r2-bucket.ts';
import type { KVNamespaceProperties } from '../providers/kv-namespace.ts';
import type { DispatchNamespaceProperties } from '../providers/dispatch-namespace.ts';
import type { CustomDomainProperties } from '../providers/custom-domain.ts';
import type { HyperdriveProperties } from '../providers/hyperdrive.ts';
import type { D1DatabaseProperties } from '../providers/d1-database.ts';
import type { QueueProperties } from '../providers/queue.ts';
import type { VectorizeProperties } from '../providers/vectorize.ts';
import type { DNSRecordProperties } from '../providers/dns-record.ts';
import type { WorkflowProperties } from '../providers/workflow.ts';
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
  readonly hyperdrives: Map<string, Hyperdrive>;
  readonly d1Databases: Map<string, D1Database>;
  readonly queues: Map<string, Queue>;
  readonly vectorizes: Map<string, Vectorize>;
  /** Map of `<ns>/<service-name>` → target Worker script name (primary container). */
  readonly serviceTargets: Map<string, string>;
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
    hyperdrives: new Map(),
    d1Databases: new Map(),
    queues: new Map(),
    vectorizes: new Map(),
    serviceTargets: new Map(),
  };
  const deployments: Deployment[] = [];
  const rollouts: Rollout[] = [];
  const statefulSets: StatefulSet[] = [];
  const dispatchNamespaces: DispatchNamespace[] = [];
  const services: ServiceResource[] = [];
  const cronJobs: CronJob[] = [];
  const jobs: Job[] = [];
  const dnsRecords: DNSRecord[] = [];

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
      case 'StatefulSet':
        statefulSets.push(r);
        break;
      case 'CronJob':
        cronJobs.push(r);
        break;
      case 'Hyperdrive':
        tables.hyperdrives.set(label, r);
        break;
      case 'D1Database':
        tables.d1Databases.set(label, r);
        break;
      case 'Queue':
        tables.queues.set(label, r);
        break;
      case 'Vectorize':
        tables.vectorizes.set(label, r);
        break;
      case 'DNSRecord':
        dnsRecords.push(r);
        break;
      case 'Job':
        jobs.push(r);
        break;
    }
  }

  const desired: DesiredResource[] = [];
  const warnings: LowerWarning[] = [];

  // Pre-pass: build the Service → target Worker map so volume serviceRef resolution
  // works regardless of resource declaration order in the manifest.
  for (const s of services) {
    const target = findServiceTarget(s, deployments, rollouts);
    if (target !== null) {
      const ns = s.metadata.namespace ?? 'default';
      tables.serviceTargets.set(`${ns}/${s.metadata.name}`, target);
    }
  }

  for (const b of tables.r2Buckets.values()) desired.push(lowerR2Bucket(b));
  for (const kv of tables.kvNamespaces.values()) desired.push(lowerKVNamespace(kv));
  for (const dn of dispatchNamespaces) desired.push(lowerDispatchNamespace(dn));
  for (const h of tables.hyperdrives.values()) desired.push(lowerHyperdrive(h, tables));
  for (const d of tables.d1Databases.values()) desired.push(lowerD1Database(d));
  for (const q of tables.queues.values()) {
    desired.push(lowerQueue(q));
  }
  for (const v of tables.vectorizes.values()) desired.push(lowerVectorize(v));
  for (const r of dnsRecords) desired.push(lowerDNSRecord(r));
  for (const d of deployments) {
    for (const w of await lowerDeployment(d, tables, options)) {
      desired.push(w);
    }
  }

  const emittedStateKvs = new Set<string>();
  for (const r of rollouts) {
    for (const d of await lowerRollout(r, tables, warnings, emittedStateKvs, options)) {
      desired.push(d);
    }
  }

  for (const c of cronJobs) {
    desired.push(await lowerCronJob(c, tables, options));
  }

  for (const s of statefulSets) {
    desired.push(await lowerStatefulSet(s, tables, options));
  }

  for (const j of jobs) {
    for (const d of await lowerJob(j, tables, options)) {
      desired.push(d);
    }
  }

  for (const s of services) {
    const out = lowerService(s, deployments, rollouts, warnings);
    if (out !== null) desired.push(out);
  }

  return { desired, warnings };
}

function lowerVectorize(v: Vectorize): DesiredResource<VectorizeProperties> {
  const ns = v.metadata.namespace ?? 'default';
  const name = v.metadata.name;
  return {
    resourceType: 'Vectorize',
    ref: refOf(v),
    label: `${ns}/${name}`,
    properties: {
      indexName: `k1c-${ns}-${name}`,
      dimensions: v.spec.dimensions,
      metric: v.spec.metric,
      ...(v.spec.description !== undefined ? { description: v.spec.description } : {}),
    },
  };
}

function lowerDNSRecord(r: DNSRecord): DesiredResource<DNSRecordProperties> {
  const ns = r.metadata.namespace ?? 'default';
  const name = r.metadata.name;
  return {
    resourceType: 'DNSRecord',
    ref: refOf(r),
    label: `${ns}/${name}`,
    properties: {
      zoneId: r.spec.zoneId,
      type: r.spec.type,
      name: r.spec.name,
      content: r.spec.content,
      ...(r.spec.ttl !== undefined ? { ttl: r.spec.ttl } : {}),
      ...(r.spec.proxied !== undefined ? { proxied: r.spec.proxied } : {}),
      ...(r.spec.priority !== undefined ? { priority: r.spec.priority } : {}),
    },
  };
}

async function lowerJob(
  j: Job,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<ReadonlyArray<DesiredResource>> {
  const ns = j.metadata.namespace ?? 'default';
  const name = j.metadata.name;
  const containers = j.spec.template.spec.containers;
  if (containers.length !== 1) {
    throw new LowerError(
      `Job ${ns}/${name}: jobTemplate must have exactly one container in v0.2 (got ${containers.length})`,
    );
  }
  const annotations = j.metadata.annotations ?? {};
  const className =
    annotations['cloudflare.com/workflow-class'] ??
    `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/-/g, '')}`;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(className)) {
    throw new LowerError(
      `Job ${ns}/${name}: derived Workflow class "${className}" is not a valid JS identifier; set \`cloudflare.com/workflow-class\` annotation explicitly`,
    );
  }
  const ref = refOf(j);
  const workers = await buildWorkerDesireds(
    'Job' as never,
    ref,
    j.metadata,
    j.spec.template,
    tables,
    options,
  );
  const worker = workers[0]!;
  const scriptName = `k1c--${ns}--${name}`;
  const workflowName = `k1c-${ns}-${name}`;
  const workflowDesired: DesiredResource<WorkflowProperties> = {
    resourceType: 'Workflow',
    ref: { ...ref, name: `${name}--workflow` },
    label: `${ns}/${name}`,
    properties: {
      workflowName,
      className,
      scriptName,
    },
    dependsOn: [ref],
  };
  return [worker, workflowDesired];
}

async function lowerStatefulSet(
  s: StatefulSet,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<DesiredResource<WorkerProperties>> {
  const ns = s.metadata.namespace ?? 'default';
  const name = s.metadata.name;
  const containers = s.spec.template.spec.containers;
  if (containers.length !== 1) {
    throw new LowerError(
      `StatefulSet ${ns}/${name}: only single-container Pods are supported in v0.2 (got ${containers.length})`,
    );
  }
  const annotations = s.metadata.annotations ?? {};
  const className =
    annotations['cloudflare.com/durable-object-class'] ??
    `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(className)) {
    throw new LowerError(
      `StatefulSet ${ns}/${name}: derived Durable Object class "${className}" is not a valid JS identifier; set \`cloudflare.com/durable-object-class\` annotation explicitly`,
    );
  }
  const ref = refOf(s);
  const workers = await buildWorkerDesireds(
    'StatefulSet' as never,
    ref,
    s.metadata,
    s.spec.template,
    tables,
    options,
  );
  const worker = workers[0]!;
  return {
    ...worker,
    properties: { ...worker.properties, durableObjectClasses: [className] },
  };
}

async function lowerCronJob(
  c: CronJob,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<DesiredResource<WorkerProperties>> {
  const ns = c.metadata.namespace ?? 'default';
  const name = c.metadata.name;
  const containers = c.spec.jobTemplate.spec.template.spec.containers;
  if (containers.length !== 1) {
    throw new LowerError(
      `CronJob ${ns}/${name}: jobTemplate must have exactly one container in v0.2 (got ${containers.length})`,
    );
  }
  const ref = refOf(c);
  const workers = await buildWorkerDesireds(
    'CronJob' as never,
    ref,
    c.metadata,
    c.spec.jobTemplate.spec.template,
    tables,
    options,
  );
  const worker = workers[0]!;
  // Suspend semantics: keep the script but clear all schedules.
  const cronSchedules = c.spec.suspend === true ? [] : [c.spec.schedule];
  return {
    ...worker,
    properties: { ...worker.properties, cronSchedules },
  };
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
    // ClusterIP services do not produce a Cloudflare resource. They are a name → Worker
    // mapping consumed by `volumes[].serviceRef` in other Pods (handled by the pre-pass
    // that populates tables.serviceTargets). If no workload matches, warn so the user
    // knows the binding will fail.
    if (findServiceTarget(s, deployments, rollouts) === null) {
      warnings.push({
        ref,
        message: `Service ${ns}/${name}: type=ClusterIP has no matching Deployment / Rollout for selector ${JSON.stringify(s.spec.selector)} (no workers will be reachable via this service)`,
      });
    }
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

/**
 * Resolves a Service to the script name of its primary target Worker, or null when
 * no Deployment / Rollout in the same namespace matches the Service selector.
 */
function findServiceTarget(
  s: ServiceResource,
  deployments: ReadonlyArray<Deployment>,
  rollouts: ReadonlyArray<Rollout>,
): string | null {
  const ns = s.metadata.namespace ?? 'default';
  const match = findWorkloadBySelector(s.spec.selector, ns, deployments, rollouts);
  if (match === null) return null;
  return `k1c--${ns}--${match.name}`;
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

function lowerHyperdrive(
  h: Hyperdrive,
  tables: LookupTables,
): DesiredResource<HyperdriveProperties> {
  const ns = h.metadata.namespace ?? 'default';
  const name = h.metadata.name;
  const sRef = h.spec.origin.passwordSecretRef;
  const sec = tables.secrets.get(`${ns}/${sRef.name}`);
  if (!sec) {
    throw new LowerError(
      `Hyperdrive ${ns}/${name}: Secret "${sRef.name}" referenced by passwordSecretRef not found in namespace "${ns}"`,
    );
  }
  const password = secretValue(sec, sRef.key);
  if (password === undefined) {
    throw new LowerError(
      `Hyperdrive ${ns}/${name}: Secret "${sRef.name}" has no key "${sRef.key}"`,
    );
  }
  const cfgName = `k1c-${ns}-${name}`;
  return {
    resourceType: 'Hyperdrive',
    ref: refOf(h),
    label: `${ns}/${name}`,
    properties: {
      name: cfgName,
      origin: {
        scheme: h.spec.origin.scheme,
        host: h.spec.origin.host,
        port: h.spec.origin.port,
        database: h.spec.origin.database,
        user: h.spec.origin.user,
        password,
      },
      ...(h.spec.caching !== undefined ? { caching: h.spec.caching } : {}),
      ...(h.spec.originConnectionLimit !== undefined
        ? { originConnectionLimit: h.spec.originConnectionLimit }
        : {}),
    },
    dependsOn: [refOf(sec)],
  };
}

function lowerD1Database(d: D1Database): DesiredResource<D1DatabaseProperties> {
  const ns = d.metadata.namespace ?? 'default';
  const name = d.metadata.name;
  return {
    resourceType: 'D1Database',
    ref: refOf(d),
    label: `${ns}/${name}`,
    properties: {
      databaseName: `k1c-${ns}-${name}`,
      ...(d.spec?.primaryLocationHint !== undefined
        ? { primaryLocationHint: d.spec.primaryLocationHint }
        : {}),
    },
  };
}

function lowerQueue(q: Queue): DesiredResource<QueueProperties> {
  const ns = q.metadata.namespace ?? 'default';
  const name = q.metadata.name;
  const consumer = q.spec?.consumer;
  return {
    resourceType: 'Queue',
    ref: refOf(q),
    label: `${ns}/${name}`,
    properties: {
      queueName: `k1c-${ns}-${name}`,
      ...(consumer !== undefined
        ? { consumerWorkerName: `k1c--${ns}--${consumer.workerName}` }
        : {}),
    },
    ...(consumer !== undefined
      ? {
          dependsOn: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              namespace: ns,
              name: consumer.workerName,
            },
          ],
        }
      : {}),
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
): Promise<ReadonlyArray<DesiredResource<WorkerProperties>>> {
  return buildWorkerDesireds(
    'Deployment',
    refOf(d),
    d.metadata,
    d.spec.template,
    tables,
    options,
  );
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
  return buildWorkerDesireds('Rollout', ref, r.metadata, r.spec.template, tables, options);
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

  // Canary path is single-container in v0.1.6. Multi-container Rollout-with-dispatch
  // would need per-container canary lifecycles, deferred to a future ADR.
  if (r.spec.template.spec.containers.length !== 1) {
    throw new LowerError(
      `Rollout ${ns}/${name}: canary Rollouts (with cloudflare.com/dispatch-namespace) currently support a single container only; got ${r.spec.template.spec.containers.length}`,
    );
  }

  // Stable Worker = the user's code, deployed into the dispatch namespace under <name>--stable.
  const userWorkers = await buildWorkerDesireds(
    'Rollout',
    ref,
    r.metadata,
    r.spec.template,
    tables,
    options,
  );
  const userWorker = userWorkers[0]!;
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

/**
 * Lowers a Pod template into one Worker per container. The first container is the
 * "primary" front-door and keeps the unsuffixed script name (`k1c--<ns>--<name>`); any
 * additional container becomes a sidecar Worker named `k1c--<ns>--<name>--<container>`.
 *
 * When the Pod has multiple containers, every Worker gets `service` bindings to all of
 * its siblings, addressable inside the Worker as `env.<container-name>.fetch(req)`.
 * This preserves the k8s "containers in a Pod talk to each other" mental model on top
 * of Cloudflare's flat Worker namespace.
 */
async function buildWorkerDesireds(
  kind: 'Deployment' | 'Rollout',
  ref: ResourceRef,
  meta: ObjectMeta,
  template: PodTemplateSpec,
  tables: LookupTables,
  options: LowerOptions | undefined,
): Promise<ReadonlyArray<DesiredResource<WorkerProperties>>> {
  const ns = meta.namespace ?? 'default';
  const name = meta.name;
  const containers = template.spec.containers;
  if (containers.length === 0) {
    throw new LowerError(`${kind} ${ns}/${name}: at least one container is required`);
  }

  const baseScriptName = `k1c--${ns}--${name}`;
  const scriptNames = containers.map((c, i) =>
    i === 0 ? baseScriptName : `${baseScriptName}--${c.name}`,
  );

  const results: DesiredResource<WorkerProperties>[] = [];
  for (let i = 0; i < containers.length; i += 1) {
    const container = containers[i]!;
    const scriptName = scriptNames[i]!;
    const containerRef: ResourceRef =
      i === 0 ? ref : { ...ref, name: `${name}--${container.name}` };
    const containerLabel = i === 0 ? `${ns}/${name}` : `${ns}/${name}--${container.name}`;

    const built = await buildContainerProperties(
      kind,
      ns,
      name,
      scriptName,
      container,
      template,
      meta.annotations ?? {},
      tables,
    );

    // Auto-wire sibling service bindings for multi-container Pods.
    let bindings = built.bindings;
    if (containers.length > 1) {
      const siblings: WorkerBinding[] = [];
      for (let j = 0; j < containers.length; j += 1) {
        if (j === i) continue;
        siblings.push({
          type: 'service',
          name: containers[j]!.name,
          service: scriptNames[j]!,
        });
      }
      bindings = [...bindings, ...siblings];
    }

    const baseProperties: WorkerProperties = {
      scriptName,
      entrypoint: container.image,
      compatibilityDate: built.compatibilityDate,
      ...(built.compatibilityFlags !== undefined
        ? { compatibilityFlags: built.compatibilityFlags }
        : {}),
      ...(Object.keys(built.vars).length > 0 ? { vars: built.vars } : {}),
      ...(Object.keys(built.secrets).length > 0 ? { secrets: built.secrets } : {}),
      ...(bindings.length > 0 ? { bindings } : {}),
      ...(built.observability !== undefined
        ? { observability: built.observability }
        : {}),
      ...(built.placement !== undefined ? { placement: built.placement } : {}),
    };
    const properties: WorkerProperties = {
      ...baseProperties,
      entrypointHash: await hashEntrypoint(baseProperties, options),
    };
    results.push({
      resourceType: 'Worker',
      ref: containerRef,
      label: containerLabel,
      properties,
      ...(built.dependsOn.length > 0 ? { dependsOn: built.dependsOn } : {}),
    });
  }
  return results;
}

interface ContainerProperties {
  readonly vars: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly bindings: WorkerBinding[];
  readonly dependsOn: ResourceRef[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags: ReadonlyArray<string> | undefined;
  readonly observability: { readonly enabled: boolean } | undefined;
  readonly placement: { readonly mode: 'smart' } | undefined;
}

async function buildContainerProperties(
  kind: 'Deployment' | 'Rollout',
  ns: string,
  name: string,
  scriptName: string,
  container: PodTemplateSpec['spec']['containers'][number],
  template: PodTemplateSpec,
  annotations: Readonly<Record<string, string>>,
  tables: LookupTables,
): Promise<ContainerProperties> {
  const dependsOn: ResourceRef[] = [];
  const vars: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const ctxLabel = `${kind} ${ns}/${name}/${container.name}`;

  for (const env of container.env ?? []) {
    if (env.value !== undefined) {
      vars[env.name] = env.value;
      continue;
    }
    const valueFrom = env.valueFrom;
    if (!valueFrom) {
      throw new LowerError(
        `${ctxLabel}: env "${env.name}" has neither value nor valueFrom`,
      );
    }
    if (valueFrom.configMapKeyRef) {
      const cmRef = valueFrom.configMapKeyRef;
      const cm = tables.configMaps.get(`${ns}/${cmRef.name}`);
      if (!cm) {
        throw new LowerError(
          `${ctxLabel}: ConfigMap "${cmRef.name}" not found in namespace "${ns}" (env ${env.name})`,
        );
      }
      const value = cm.data?.[cmRef.key];
      if (value === undefined) {
        throw new LowerError(
          `${ctxLabel}: ConfigMap "${cmRef.name}" has no key "${cmRef.key}"`,
        );
      }
      vars[env.name] = value;
      pushUnique(dependsOn, refOf(cm));
    } else if (valueFrom.secretKeyRef) {
      const sRef = valueFrom.secretKeyRef;
      const sec = tables.secrets.get(`${ns}/${sRef.name}`);
      if (!sec) {
        throw new LowerError(
          `${ctxLabel}: Secret "${sRef.name}" not found in namespace "${ns}" (env ${env.name})`,
        );
      }
      const value = secretValue(sec, sRef.key);
      if (value === undefined) {
        throw new LowerError(
          `${ctxLabel}: Secret "${sRef.name}" has no key "${sRef.key}"`,
        );
      }
      secrets[env.name] = value;
      pushUnique(dependsOn, refOf(sec));
    } else {
      throw new LowerError(
        `${ctxLabel}: env "${env.name}" valueFrom must specify configMapKeyRef or secretKeyRef`,
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
        `${ctxLabel}: volumeMount "${mount.name}" has no matching volume`,
      );
    }
    if (vol.r2BucketRef) {
      const b = tables.r2Buckets.get(`${ns}/${vol.r2BucketRef.name}`);
      if (!b) {
        throw new LowerError(
          `${ctxLabel}: R2Bucket "${vol.r2BucketRef.name}" not found in namespace "${ns}"`,
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
          `${ctxLabel}: KVNamespace "${vol.kvNamespaceRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'kv_namespace',
        name: mount.mountPath,
        namespaceId: `<resolved-at-apply:${kv.metadata.name}>`,
      });
      pushUnique(dependsOn, refOf(kv));
    } else if (vol.serviceRef) {
      const targetScriptName = tables.serviceTargets.get(`${ns}/${vol.serviceRef.name}`);
      if (targetScriptName === undefined) {
        throw new LowerError(
          `${ctxLabel}: Service "${vol.serviceRef.name}" not found (or has no matching workload) in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'service',
        name: mount.mountPath,
        service: targetScriptName,
      });
      pushUnique(dependsOn, {
        apiVersion: 'v1',
        kind: 'Service',
        namespace: ns,
        name: vol.serviceRef.name,
      });
    } else if (vol.hyperdriveRef) {
      const h = tables.hyperdrives.get(`${ns}/${vol.hyperdriveRef.name}`);
      if (!h) {
        throw new LowerError(
          `${ctxLabel}: Hyperdrive "${vol.hyperdriveRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'hyperdrive',
        name: mount.mountPath,
        hyperdriveId: `<resolved-at-apply:hyperdrive:${h.metadata.name}>`,
      });
      pushUnique(dependsOn, refOf(h));
    } else if (vol.d1DatabaseRef) {
      const d = tables.d1Databases.get(`${ns}/${vol.d1DatabaseRef.name}`);
      if (!d) {
        throw new LowerError(
          `${ctxLabel}: D1Database "${vol.d1DatabaseRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'd1',
        name: mount.mountPath,
        databaseId: `<resolved-at-apply:d1:${d.metadata.name}>`,
      });
      pushUnique(dependsOn, refOf(d));
    } else if (vol.queueRef) {
      const q = tables.queues.get(`${ns}/${vol.queueRef.name}`);
      if (!q) {
        throw new LowerError(
          `${ctxLabel}: Queue "${vol.queueRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'queue',
        name: mount.mountPath,
        queueName: `k1c-${ns}-${q.metadata.name}`,
      });
      pushUnique(dependsOn, refOf(q));
    } else if (vol.vectorizeRef) {
      const v = tables.vectorizes.get(`${ns}/${vol.vectorizeRef.name}`);
      if (!v) {
        throw new LowerError(
          `${ctxLabel}: Vectorize "${vol.vectorizeRef.name}" not found in namespace "${ns}"`,
        );
      }
      bindings.push({
        type: 'vectorize',
        name: mount.mountPath,
        indexName: `k1c-${ns}-${v.metadata.name}`,
      });
      pushUnique(dependsOn, refOf(v));
    } else {
      throw new LowerError(
        `${ctxLabel}: volume "${vol.name}" has no recognised reference (r2BucketRef, kvNamespaceRef, serviceRef, hyperdriveRef, d1DatabaseRef, queueRef, or vectorizeRef)`,
      );
    }
  }

  // Annotations are pod-level: every container in the Pod inherits compatibility-date,
  // observability, smart-placement, etc. This matches kubectl semantics.
  const flagsAnno = annotations['cloudflare.com/compatibility-flags'];
  const compatibilityFlags = flagsAnno
    ? flagsAnno
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  // scriptName is parameter-only so the function compiles cleanly without referencing it
  // outside the result; the caller wires it into WorkerProperties.
  void scriptName;

  return {
    vars,
    secrets,
    bindings,
    dependsOn,
    compatibilityDate:
      annotations['cloudflare.com/compatibility-date'] ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags,
    observability:
      annotations['cloudflare.com/observability'] === 'enabled'
        ? { enabled: true }
        : undefined,
    placement:
      annotations['cloudflare.com/smart-placement'] === 'smart'
        ? { mode: 'smart' as const }
        : undefined,
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
