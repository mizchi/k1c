import type Cloudflare from 'cloudflare';
import type { CanaryEffects } from './runtime.ts';
import type { WorkerBinding, WorkerProperties } from '../providers/worker.ts';

const MAIN_MODULE = 'worker.mjs';

interface CFBinding {
  type: string;
  name: string;
  text?: string;
  bucket_name?: string;
  namespace_id?: string;
  service?: string;
  namespace?: string;
}

function buildBindings(props: WorkerProperties): CFBinding[] {
  const out: CFBinding[] = [];
  for (const [name, text] of Object.entries(props.vars ?? {})) {
    out.push({ type: 'plain_text', name, text });
  }
  for (const [name, text] of Object.entries(props.secrets ?? {})) {
    out.push({ type: 'secret_text', name, text });
  }
  for (const b of props.bindings ?? ([] as ReadonlyArray<WorkerBinding>)) {
    if (b.type === 'r2_bucket') {
      out.push({ type: 'r2_bucket', name: b.name, bucket_name: b.bucketName });
    } else if (b.type === 'kv_namespace') {
      out.push({ type: 'kv_namespace', name: b.name, namespace_id: b.namespaceId });
    } else if (b.type === 'service') {
      out.push({ type: 'service', name: b.name, service: b.service });
    } else if (b.type === 'dispatch_namespace') {
      out.push({ type: 'dispatch_namespace', name: b.name, namespace: b.dispatchNamespace });
    }
  }
  return out;
}

function buildMetadata(props: WorkerProperties, managedByLabel: string) {
  return {
    main_module: MAIN_MODULE,
    compatibility_date: props.compatibilityDate,
    ...(props.compatibilityFlags !== undefined
      ? { compatibility_flags: [...props.compatibilityFlags] }
      : {}),
    bindings: buildBindings(props),
    tags: [managedByLabel, 'k1c.io/role=canary'],
    ...(props.observability !== undefined
      ? { observability: { enabled: props.observability.enabled } }
      : {}),
    ...(props.placement !== undefined ? { placement: { mode: props.placement.mode } } : {}),
  };
}

export interface BuildEffectsOptions {
  readonly cloudflare: Cloudflare;
  readonly accountId: string;
  readonly managedByLabel: string;
}

export function buildCloudflareEffects(opts: BuildEffectsOptions): CanaryEffects {
  const upload = async (
    dispatchNamespace: string,
    scriptName: string,
    content: Uint8Array,
    properties: WorkerProperties,
  ) => {
    const file = new File([content], MAIN_MODULE, {
      type: 'application/javascript+module',
    });
    await opts.cloudflare.workersForPlatforms.dispatch.namespaces.scripts.update(
      dispatchNamespace,
      scriptName,
      {
        account_id: opts.accountId,
        metadata: buildMetadata(properties, opts.managedByLabel),
        files: { [MAIN_MODULE]: file },
      } as never,
    );
  };

  return {
    async uploadCanary(input) {
      await upload(input.dispatchNamespace, input.scriptName, input.content, input.properties);
    },
    async promoteCanaryToStable(input) {
      // Re-upload the canary content as the stable script, then remove the canary.
      await upload(
        input.dispatchNamespace,
        input.stableScriptName,
        input.content,
        input.properties,
      );
      await opts.cloudflare.workersForPlatforms.dispatch.namespaces.scripts.delete(
        input.dispatchNamespace,
        input.canaryScriptName,
        { account_id: opts.accountId },
      );
    },
    async removeCanary(input) {
      await opts.cloudflare.workersForPlatforms.dispatch.namespaces.scripts.delete(
        input.dispatchNamespace,
        input.scriptName,
        { account_id: opts.accountId },
      );
    },
  };
}
