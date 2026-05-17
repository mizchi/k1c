import { lower } from '../manifest/lower.ts';
import { parseManifest } from '../manifest/parse.ts';
import type { WorkerBinding, WorkerProperties } from '../providers/worker.ts';
import type { DesiredResource } from '../reconciler/types.ts';
import type { WranglerConfigArgs } from './args.ts';

export interface WranglerConfigDeps {
  readonly readManifest: (path: string) => Promise<string>;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

export async function runWranglerConfig(
  args: WranglerConfigArgs,
  deps: WranglerConfigDeps,
): Promise<number> {
  let manifest: string;
  try {
    manifest = await deps.readManifest(args.file);
  } catch (e) {
    deps.err(`failed to read manifest ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  let parsed;
  try {
    parsed = parseManifest(manifest);
  } catch (e) {
    deps.err(`manifest parse error: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  let lowered;
  try {
    lowered = await lower(parsed.resources, { readFile: deps.readFile });
  } catch (e) {
    deps.err(`lower error: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  const worker = selectWorker(lowered.desired.filter(isWorkerDesired), args.worker);
  if ('error' in worker) {
    deps.err(worker.error);
    return 2;
  }

  deps.out(JSON.stringify(toWranglerConfig(worker.properties), null, 2));
  return 0;
}

function isWorkerDesired(d: DesiredResource): d is DesiredResource<WorkerProperties> {
  return d.resourceType === 'Worker';
}

function selectWorker(
  workers: ReadonlyArray<DesiredResource<WorkerProperties>>,
  requested: string | undefined,
): DesiredResource<WorkerProperties> | { error: string } {
  if (workers.length === 0) {
    return { error: 'manifest does not lower to any Worker resources' };
  }
  if (requested !== undefined) {
    const label = requested.includes('/') ? requested : `default/${requested}`;
    const match = workers.find((w) => w.label === label || w.properties.scriptName === requested);
    if (match !== undefined) return match;
    return {
      error: `Worker "${requested}" not found. Available Workers: ${workers.map((w) => w.label).join(', ')}`,
    };
  }
  if (workers.length === 1) return workers[0]!;
  return {
    error: `manifest lowers to multiple Workers; pass --worker <namespace/name>. Available Workers: ${workers.map((w) => w.label).join(', ')}`,
  };
}

type WranglerObject = Record<string, unknown>;

function toWranglerConfig(props: WorkerProperties): WranglerObject {
  const config: WranglerObject = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: props.scriptName,
    main: props.entrypoint,
    no_bundle: true,
    compatibility_date: props.compatibilityDate,
  };

  if (props.compatibilityFlags !== undefined && props.compatibilityFlags.length > 0) {
    config['compatibility_flags'] = [...props.compatibilityFlags];
  }
  if (props.vars !== undefined && Object.keys(props.vars).length > 0) {
    config['vars'] = { ...props.vars };
  }
  if (props.observability !== undefined) {
    config['observability'] = { enabled: props.observability.enabled };
  }
  if (props.placement !== undefined) {
    config['placement'] = { mode: props.placement.mode };
  }
  if (props.cronSchedules !== undefined && props.cronSchedules.length > 0) {
    config['triggers'] = { crons: [...props.cronSchedules] };
  }

  const grouped = groupWranglerBindings(props.bindings ?? []);
  for (const [key, value] of Object.entries(grouped)) {
    config[key] = value;
  }
  if (props.durableObjectClasses !== undefined && props.durableObjectClasses.length > 0) {
    const classes = [...props.durableObjectClasses];
    const durableObjects = (config['durable_objects'] as WranglerObject | undefined) ?? {};
    const existing = (durableObjects['bindings'] as WranglerObject[] | undefined) ?? [];
    durableObjects['bindings'] = [
      ...existing,
      ...classes.map((className) => ({
        name: className,
        class_name: className,
      })),
    ];
    config['durable_objects'] = durableObjects;
    config['migrations'] = [
      ...((config['migrations'] as WranglerObject[] | undefined) ?? []),
      { tag: 'k1c-initial', new_sqlite_classes: classes },
    ];
  }

  return config;
}

function groupWranglerBindings(bindings: ReadonlyArray<WorkerBinding>): WranglerObject {
  const out: WranglerObject = {};
  const push = (key: string, value: WranglerObject) => {
    const arr = (out[key] as WranglerObject[] | undefined) ?? [];
    arr.push(value);
    out[key] = arr;
  };

  for (const b of bindings) {
    switch (b.type) {
      case 'r2_bucket':
        push('r2_buckets', { binding: b.name, bucket_name: b.bucketName });
        break;
      case 'kv_namespace':
        push('kv_namespaces', withOptionalId({ binding: b.name }, 'id', b.namespaceId));
        break;
      case 'service':
        push('services', { binding: b.name, service: b.service });
        break;
      case 'dispatch_namespace':
        push('dispatch_namespaces', {
          binding: b.name,
          namespace: b.dispatchNamespace,
          ...(b.remote !== undefined ? { remote: b.remote } : {}),
        });
        break;
      case 'hyperdrive':
        push('hyperdrive', withOptionalId({ binding: b.name }, 'id', b.hyperdriveId));
        break;
      case 'd1':
        push('d1_databases', withOptionalId({ binding: b.name }, 'database_id', b.databaseId));
        break;
      case 'queue':
        out['queues'] = {
          ...((out['queues'] as WranglerObject | undefined) ?? {}),
          producers: [
            ...(((out['queues'] as { producers?: WranglerObject[] } | undefined)?.producers) ?? []),
            { binding: b.name, queue: b.queueName },
          ],
        };
        break;
      case 'durable_object_namespace':
        out['durable_objects'] = {
          ...((out['durable_objects'] as WranglerObject | undefined) ?? {}),
          bindings: [
            ...(((out['durable_objects'] as { bindings?: WranglerObject[] } | undefined)
              ?.bindings) ?? []),
            {
              name: b.name,
              class_name: b.className,
              ...(b.scriptName !== undefined ? { script_name: b.scriptName } : {}),
            },
          ],
        };
        break;
      case 'vectorize':
        push('vectorize', { binding: b.name, index_name: b.indexName });
        break;
      case 'ai':
        out['ai'] = { binding: b.name };
        break;
      case 'browser':
        out['browser'] = { binding: b.name };
        break;
      case 'images':
        out['images'] = { binding: b.name };
        break;
      case 'worker_loader':
        push('worker_loaders', { binding: b.name });
        break;
      case 'version_metadata':
        out['version_metadata'] = { binding: b.name };
        break;
      case 'analytics_engine':
        push('analytics_engine_datasets', { binding: b.name, dataset: b.dataset });
        break;
      case 'mtls_certificate':
        push('mtls_certificates', { binding: b.name, certificate_id: b.certificateId });
        break;
      case 'pipelines':
        push('pipelines', { binding: b.name, pipeline: b.pipeline });
        break;
    }
  }

  return out;
}

function withOptionalId(base: WranglerObject, key: string, value: string): WranglerObject {
  if (isApplyPlaceholder(value)) return base;
  return { ...base, [key]: value };
}

function isApplyPlaceholder(value: string): boolean {
  return value.startsWith('<resolved-at-apply:');
}
