import { z } from 'zod';
import type {
  CloudflareResourceProvider,
  CreateResult,
  DeleteResult,
  ListedResource,
  ProviderContext,
  UpdateResult,
} from './types.ts';
import { NotFound } from './types.ts';
import { toProviderError } from './errors.ts';

export interface WorkerProperties {
  readonly scriptName: string;
  readonly entrypoint: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
  readonly vars?: Readonly<Record<string, string>>;
  // v0: key→value carried inline. Cloudflare's read-back never returns values, so
  // this field is always considered "drifted" by propertiesEqual until k1c.io/last-applied
  // annotation diffing is implemented.
  readonly secrets?: Readonly<Record<string, string>>;
  readonly bindings?: ReadonlyArray<WorkerBinding>;
  readonly observability?: { readonly enabled: boolean };
  readonly placement?: { readonly mode: 'smart' };
  /**
   * If set, the Worker is uploaded to a Workers for Platforms dispatch namespace
   * (`scripts.update` on the namespace endpoint, no versioned deployment) instead of as a
   * top-level Worker. Used by canary Rollouts to register the stable / candidate variants.
   */
  readonly dispatchNamespace?: string;
  /**
   * If set, this string is uploaded as the script body verbatim and `entrypoint` is
   * ignored for I/O. Used for k1c-generated workers (dispatcher, etc.) whose source is
   * synthesized in-process rather than read from disk.
   */
  readonly entrypointContent?: string;
  /**
   * SHA-256 hex of the entrypoint bytes. Computed by lower; round-tripped through
   * `metadata.tags` as `k1c.io/content-hash=<hash>` so the read path can reconstruct
   * it from the live script and propertiesEqual catches file-only edits.
   */
  readonly entrypointHash?: string;
  /**
   * Cron expressions wired to the script via `cloudflare.workers.scripts.schedules`.
   * Set by lowerCronJob; an empty array (or undefined) means the script has no
   * cron triggers.
   */
  readonly cronSchedules?: ReadonlyArray<string>;
  /**
   * Durable Object class names this Worker defines. Lowering a `StatefulSet` populates
   * this. The Worker provider:
   *  - emits one `durable_object_namespace` self-binding per class
   *  - on first deploy (no `k1c.io/do-classes=` tag in prior), declares them via
   *    `metadata.migrations.new_sqlite_classes`. Adding / removing classes on a
   *    later apply is **not yet implemented** in v0.2; CF will reject migrations
   *    that try to redeclare an existing class.
   */
  readonly durableObjectClasses?: ReadonlyArray<string>;
}

export type WorkerBinding =
  | { readonly type: 'r2_bucket'; readonly name: string; readonly bucketName: string }
  | { readonly type: 'kv_namespace'; readonly name: string; readonly namespaceId: string }
  | { readonly type: 'service'; readonly name: string; readonly service: string }
  | {
      readonly type: 'dispatch_namespace';
      readonly name: string;
      readonly dispatchNamespace: string;
    }
  | { readonly type: 'hyperdrive'; readonly name: string; readonly hyperdriveId: string }
  | { readonly type: 'd1'; readonly name: string; readonly databaseId: string }
  | { readonly type: 'queue'; readonly name: string; readonly queueName: string }
  | {
      readonly type: 'durable_object_namespace';
      readonly name: string;
      readonly className: string;
      /** When the DO class lives in another script, set this to that script's name. */
      readonly scriptName?: string;
    }
  | { readonly type: 'vectorize'; readonly name: string; readonly indexName: string };

export const workerSchema: z.ZodType<WorkerProperties> = z.object({
  scriptName: z.string(),
  entrypoint: z.string(),
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()).optional(),
  vars: z.record(z.string()).optional(),
  secrets: z.record(z.string()).optional(),
  bindings: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('r2_bucket'),
          name: z.string(),
          bucketName: z.string(),
        }),
        z.object({
          type: z.literal('kv_namespace'),
          name: z.string(),
          namespaceId: z.string(),
        }),
        z.object({
          type: z.literal('service'),
          name: z.string(),
          service: z.string(),
        }),
        z.object({
          type: z.literal('dispatch_namespace'),
          name: z.string(),
          dispatchNamespace: z.string(),
        }),
        z.object({
          type: z.literal('hyperdrive'),
          name: z.string(),
          hyperdriveId: z.string(),
        }),
        z.object({
          type: z.literal('d1'),
          name: z.string(),
          databaseId: z.string(),
        }),
        z.object({
          type: z.literal('queue'),
          name: z.string(),
          queueName: z.string(),
        }),
        z.object({
          type: z.literal('durable_object_namespace'),
          name: z.string(),
          className: z.string(),
          scriptName: z.string().optional(),
        }),
        z.object({
          type: z.literal('vectorize'),
          name: z.string(),
          indexName: z.string(),
        }),
      ]),
    )
    .optional(),
  observability: z.object({ enabled: z.boolean() }).optional(),
  placement: z.object({ mode: z.literal('smart') }).optional(),
  dispatchNamespace: z.string().optional(),
  entrypointContent: z.string().optional(),
  entrypointHash: z.string().optional(),
  cronSchedules: z.array(z.string()).optional(),
  durableObjectClasses: z.array(z.string()).optional(),
});

const NAME_PREFIX = 'k1c--';
const SEPARATOR = '--';
const MAIN_MODULE = 'worker.mjs';

function parseLabel(scriptName: string): string | null {
  if (!scriptName.startsWith(NAME_PREFIX)) return null;
  const rest = scriptName.slice(NAME_PREFIX.length);
  const sepIdx = rest.indexOf(SEPARATOR);
  if (sepIdx <= 0 || sepIdx + SEPARATOR.length === rest.length) return null;
  const namespace = rest.slice(0, sepIdx);
  const name = rest.slice(sepIdx + SEPARATOR.length);
  if (!name) return null;
  return `${namespace}/${name}`;
}

interface CFBinding {
  readonly type: string;
  readonly name: string;
  readonly text?: string;
  readonly bucket_name?: string;
  readonly namespace_id?: string;
  readonly service?: string;
  readonly namespace?: string; // for dispatch_namespace bindings
  readonly id?: string; // for hyperdrive / d1 bindings
  readonly queue_name?: string; // for queue bindings
  readonly class_name?: string; // for durable_object_namespace bindings
  readonly script_name?: string; // for cross-script DO bindings
  readonly index_name?: string; // for vectorize bindings
}

function buildBindings(props: WorkerProperties): CFBinding[] {
  const out: CFBinding[] = [];
  for (const [name, text] of Object.entries(props.vars ?? {})) {
    out.push({ type: 'plain_text', name, text });
  }
  for (const [name, text] of Object.entries(props.secrets ?? {})) {
    out.push({ type: 'secret_text', name, text });
  }
  for (const b of props.bindings ?? []) {
    if (b.type === 'r2_bucket') {
      out.push({ type: 'r2_bucket', name: b.name, bucket_name: b.bucketName });
    } else if (b.type === 'kv_namespace') {
      out.push({ type: 'kv_namespace', name: b.name, namespace_id: b.namespaceId });
    } else if (b.type === 'service') {
      out.push({ type: 'service', name: b.name, service: b.service });
    } else if (b.type === 'dispatch_namespace') {
      out.push({ type: 'dispatch_namespace', name: b.name, namespace: b.dispatchNamespace });
    } else if (b.type === 'hyperdrive') {
      out.push({ type: 'hyperdrive', name: b.name, id: b.hyperdriveId });
    } else if (b.type === 'd1') {
      out.push({ type: 'd1', name: b.name, id: b.databaseId });
    } else if (b.type === 'queue') {
      out.push({ type: 'queue', name: b.name, queue_name: b.queueName });
    } else if (b.type === 'durable_object_namespace') {
      out.push({
        type: 'durable_object_namespace',
        name: b.name,
        class_name: b.className,
        ...(b.scriptName !== undefined ? { script_name: b.scriptName } : {}),
      });
    } else if (b.type === 'vectorize') {
      out.push({ type: 'vectorize', name: b.name, index_name: b.indexName });
    }
  }
  return out;
}

const CONTENT_HASH_TAG_PREFIX = 'k1c.io/content-hash=';
const DO_CLASSES_TAG_PREFIX = 'k1c.io/do-classes=';

function buildMetadata(ctx: ProviderContext, props: WorkerProperties) {
  const tags = [ctx.managedByLabel];
  if (props.entrypointHash !== undefined) {
    tags.push(`${CONTENT_HASH_TAG_PREFIX}${props.entrypointHash}`);
  }
  const classes = [...(props.durableObjectClasses ?? [])].sort();
  if (classes.length > 0) {
    tags.push(`${DO_CLASSES_TAG_PREFIX}${classes.join(',')}`);
  }
  // Auto-include self-pointing DO bindings for every declared class so the Worker
  // can address its own DO instances by name (e.g. `env.<class>.idFromName(id)`).
  const selfDoBindings: WorkerBinding[] = classes.map((className) => ({
    type: 'durable_object_namespace',
    name: className,
    className,
  }));
  const allBindings = buildBindings({
    ...props,
    bindings: [...(props.bindings ?? []), ...selfDoBindings],
  });
  return {
    main_module: MAIN_MODULE,
    compatibility_date: props.compatibilityDate,
    ...(props.compatibilityFlags !== undefined
      ? { compatibility_flags: [...props.compatibilityFlags] }
      : {}),
    bindings: allBindings,
    tags,
    ...(props.observability !== undefined
      ? { observability: { enabled: props.observability.enabled } }
      : {}),
    ...(props.placement !== undefined ? { placement: { mode: props.placement.mode } } : {}),
    ...(classes.length > 0
      ? {
          migrations: {
            new_sqlite_classes: classes,
            new_tag: props.entrypointHash ?? 'k1c-initial',
          },
        }
      : {}),
  };
}

function extractContentHash(tags: ReadonlyArray<string> | undefined): string | undefined {
  if (!tags) return undefined;
  for (const tag of tags) {
    if (tag.startsWith(CONTENT_HASH_TAG_PREFIX)) return tag.slice(CONTENT_HASH_TAG_PREFIX.length);
  }
  return undefined;
}

function extractDoClasses(tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined {
  if (!tags) return undefined;
  for (const tag of tags) {
    if (tag.startsWith(DO_CLASSES_TAG_PREFIX)) {
      const list = tag.slice(DO_CLASSES_TAG_PREFIX.length);
      if (!list) return undefined;
      return list.split(',').filter((s) => s.length > 0);
    }
  }
  return undefined;
}

async function readEntrypoint(
  ctx: ProviderContext,
  props: WorkerProperties,
): Promise<Uint8Array> {
  if (props.entrypointContent !== undefined) {
    return new TextEncoder().encode(props.entrypointContent);
  }
  const reader =
    ctx.readFile ??
    (async (p: string) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(p);
    });
  return reader(props.entrypoint);
}

async function uploadAndDeploy(
  ctx: ProviderContext,
  props: WorkerProperties,
): Promise<{ scriptId: string; versionId: string }> {
  if (props.dispatchNamespace !== undefined) {
    return uploadToDispatchNamespace(ctx, props, props.dispatchNamespace);
  }
  return uploadVersionAndDeploy(ctx, props);
}

async function uploadVersionAndDeploy(
  ctx: ProviderContext,
  props: WorkerProperties,
): Promise<{ scriptId: string; versionId: string }> {
  const content = await readEntrypoint(ctx, props);
  const file = new File([content], MAIN_MODULE, { type: 'application/javascript+module' });

  // 1. Upload a new immutable version (does not deploy to traffic).
  const versionResult = await ctx.cloudflare.workers.scripts.versions.create(
    props.scriptName,
    {
      account_id: ctx.accountId,
      metadata: buildMetadata(ctx, props),
      [MAIN_MODULE]: [file],
    } as never,
  );
  const versionId = (versionResult as { id?: string }).id;
  if (!versionId) {
    throw new Error('versions.create did not return a version id');
  }

  // 2. Cut over: route 100% of traffic to the new version (cutover semantics).
  // canary.steps and blueGreen with manual promotion are not yet implemented (v0.1.2).
  await ctx.cloudflare.workers.scripts.deployments.create(props.scriptName, {
    account_id: ctx.accountId,
    strategy: 'percentage',
    versions: [{ version_id: versionId, percentage: 100 }],
  } as never);

  // 3. Sync cron triggers if the manifest declared any (CronJob path).
  await syncCronSchedules(ctx, props);

  return { scriptId: props.scriptName, versionId };
}

async function syncCronSchedules(
  ctx: ProviderContext,
  props: WorkerProperties,
): Promise<void> {
  const schedules = props.cronSchedules ?? [];
  await ctx.cloudflare.workers.scripts.schedules.update(props.scriptName, {
    account_id: ctx.accountId,
    body: schedules.map((cron) => ({ cron })),
  });
}

async function uploadToDispatchNamespace(
  ctx: ProviderContext,
  props: WorkerProperties,
  dispatchNamespace: string,
): Promise<{ scriptId: string; versionId: string }> {
  const content = await readEntrypoint(ctx, props);
  const file = new File([content], MAIN_MODULE, { type: 'application/javascript+module' });

  // Dispatch-namespace scripts do not currently flow through the Versions/Deployments API.
  // The dispatcher Worker invokes them by name on each request, so a single mutable script
  // per name is the right model.
  await ctx.cloudflare.workersForPlatforms.dispatch.namespaces.scripts.update(
    dispatchNamespace,
    props.scriptName,
    {
      account_id: ctx.accountId,
      metadata: buildMetadata(ctx, props),
      files: { [MAIN_MODULE]: file },
    } as never,
  );

  return { scriptId: props.scriptName, versionId: 'dispatched' };
}

function fromCFBinding(b: CFBinding): unknown {
  if (b.type === 'r2_bucket' && b.bucket_name !== undefined) {
    return { type: 'r2_bucket', name: b.name, bucketName: b.bucket_name };
  }
  if (b.type === 'kv_namespace' && b.namespace_id !== undefined) {
    return { type: 'kv_namespace', name: b.name, namespaceId: b.namespace_id };
  }
  if (b.type === 'service' && b.service !== undefined) {
    return { type: 'service', name: b.name, service: b.service };
  }
  if (b.type === 'dispatch_namespace' && b.namespace !== undefined) {
    return { type: 'dispatch_namespace', name: b.name, dispatchNamespace: b.namespace };
  }
  if (b.type === 'hyperdrive' && b.id !== undefined) {
    return { type: 'hyperdrive', name: b.name, hyperdriveId: b.id };
  }
  if (b.type === 'd1' && b.id !== undefined) {
    return { type: 'd1', name: b.name, databaseId: b.id };
  }
  if (b.type === 'queue' && b.queue_name !== undefined) {
    return { type: 'queue', name: b.name, queueName: b.queue_name };
  }
  if (b.type === 'durable_object_namespace' && b.class_name !== undefined) {
    return {
      type: 'durable_object_namespace',
      name: b.name,
      className: b.class_name,
      ...(b.script_name !== undefined ? { scriptName: b.script_name } : {}),
    };
  }
  if (b.type === 'vectorize' && b.index_name !== undefined) {
    return { type: 'vectorize', name: b.name, indexName: b.index_name };
  }
  return null;
}

export const workerProvider: CloudflareResourceProvider<WorkerProperties> = {
  resourceType: 'Worker',
  schema: workerSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.workers.scripts.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const script of iter) {
        const id = script.id;
        if (!id) continue;
        const label = parseLabel(id);
        if (label === null) continue;
        yield { nativeId: id, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId): Promise<WorkerProperties | NotFound> {
    let response;
    try {
      response = await ctx.cloudflare.workers.scripts.scriptAndVersionSettings.get(nativeId, {
        account_id: ctx.accountId,
      });
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
    const settings = response as {
      compatibility_date?: string;
      compatibility_flags?: string[];
      bindings?: CFBinding[];
      observability?: { enabled?: boolean };
      placement?: { mode?: 'smart' };
      tags?: string[];
    };
    const entrypointHash = extractContentHash(settings.tags);
    const durableObjectClasses = extractDoClasses(settings.tags);

    let cronSchedules: ReadonlyArray<string> | undefined;
    try {
      const sched = await ctx.cloudflare.workers.scripts.schedules.get(nativeId, {
        account_id: ctx.accountId,
      });
      const list = (sched as { schedules?: Array<{ cron?: string }> }).schedules ?? [];
      const crons = list.map((s) => s.cron).filter((c): c is string => typeof c === 'string');
      if (crons.length > 0) cronSchedules = crons;
    } catch {
      // schedules.get may fail (no triggers, transient error) — treat as no schedules.
    }

    const vars: Record<string, string> = {};
    const bindings: WorkerBinding[] = [];
    for (const b of settings.bindings ?? []) {
      if (b.type === 'plain_text' && b.text !== undefined) {
        vars[b.name] = b.text;
        continue;
      }
      if (b.type === 'secret_text') {
        // Secret values are never returned by Cloudflare; skip silently.
        continue;
      }
      const translated = fromCFBinding(b);
      if (translated !== null) bindings.push(translated as WorkerBinding);
    }

    const props: WorkerProperties = {
      scriptName: nativeId,
      entrypoint: '<read-from-cluster>',
      compatibilityDate: settings.compatibility_date ?? '2025-01-01',
      ...(settings.compatibility_flags !== undefined
        ? { compatibilityFlags: settings.compatibility_flags }
        : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(bindings.length > 0 ? { bindings } : {}),
      ...(settings.observability?.enabled !== undefined
        ? { observability: { enabled: settings.observability.enabled } }
        : {}),
      ...(settings.placement?.mode === 'smart'
        ? { placement: { mode: 'smart' as const } }
        : {}),
      ...(entrypointHash !== undefined ? { entrypointHash } : {}),
      ...(cronSchedules !== undefined ? { cronSchedules } : {}),
      ...(durableObjectClasses !== undefined ? { durableObjectClasses } : {}),
    };
    return props;
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const { scriptId } = await uploadAndDeploy(ctx, desired);
      return { kind: 'sync', nativeId: scriptId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, _nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      const { scriptId } = await uploadAndDeploy(ctx, desired);
      return { kind: 'sync', nativeId: scriptId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.workers.scripts.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
