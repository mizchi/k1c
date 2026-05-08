import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import type { K1cResource } from './types.ts';
import { k1cResourceSchema } from './schemas.ts';

export class ManifestParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManifestParseError';
  }
}

export interface ParseRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
}

export interface ParseWarning {
  readonly ref: ParseRef | null;
  readonly message: string;
}

export interface ParseResult {
  readonly resources: ReadonlyArray<K1cResource>;
  readonly warnings: ReadonlyArray<ParseWarning>;
}

const OUT_OF_SCOPE = new Map<string, string>([
  ['Pod', 'Pod is not supported. Wrap workloads in a Deployment instead.'],
  ['DaemonSet', 'DaemonSet is not supported on Cloudflare; the edge is implicitly global.'],
  ['NetworkPolicy', 'NetworkPolicy is not supported. Use Service Bindings or WAF.'],
  ['Endpoints', 'Endpoints is an internal Service detail and not user-applied.'],
  ['EndpointSlice', 'EndpointSlice is an internal Service detail and not user-applied.'],
]);

const NOOP_WITH_WARNING = new Map<string, string>([
  ['HorizontalPodAutoscaler', 'HPA is no-op on Cloudflare; Workers auto-scale automatically.'],
  ['PodDisruptionBudget', 'PodDisruptionBudget has no effect on Cloudflare Workers.'],
  ['LimitRange', 'LimitRange has no effect; account-level limits apply instead.'],
  ['ResourceQuota', 'ResourceQuota has no effect; account-level limits apply instead.'],
]);

export function parseManifest(text: string): ParseResult {
  const docs = parseAllDocuments(text);
  const resources: K1cResource[] = [];
  const warnings: ParseWarning[] = [];

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      const first = doc.errors[0]!;
      throw new ManifestParseError(`YAML parse error: ${first.message}`, { cause: first });
    }
    const data: unknown = doc.toJS();
    if (data == null) continue;
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new ManifestParseError(`expected mapping at document root, got ${Array.isArray(data) ? 'array' : typeof data}`);
    }

    const obj = data as Record<string, unknown>;
    const kind = obj['kind'];
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new ManifestParseError('manifest is missing required field "kind"');
    }

    const outOfScope = OUT_OF_SCOPE.get(kind);
    if (outOfScope !== undefined) {
      throw new ManifestParseError(`${kind} is not supported: ${outOfScope}`);
    }

    const noopReason = NOOP_WITH_WARNING.get(kind);
    if (noopReason !== undefined) {
      warnings.push({ ref: extractRef(obj), message: noopReason });
      continue;
    }

    const parsed = parseAndValidate(obj, kind);
    const withDefaults = applyDefaults(parsed);
    resources.push(withDefaults);
  }

  return { resources, warnings };
}

function parseAndValidate(obj: Record<string, unknown>, kind: string): K1cResource {
  const result = k1cResourceSchema.safeParse(obj);
  if (result.success) return result.data as K1cResource;

  const issue = result.error.issues[0];
  if (issue?.code === 'invalid_union_discriminator') {
    const apiVersion = obj['apiVersion'];
    throw new ManifestParseError(
      `unknown kind: ${kind} (apiVersion=${typeof apiVersion === 'string' ? apiVersion : '?'})`,
      { cause: result.error },
    );
  }

  throw new ManifestParseError(formatZodError(result.error, kind), { cause: result.error });
}

function applyDefaults(resource: K1cResource): K1cResource {
  if (resource.metadata.namespace) return resource;
  return {
    ...resource,
    metadata: { ...resource.metadata, namespace: 'default' },
  } as K1cResource;
}

function extractRef(obj: Record<string, unknown>): ParseRef | null {
  const apiVersion = obj['apiVersion'];
  const kind = obj['kind'];
  const metadata = obj['metadata'];
  if (typeof apiVersion !== 'string') return null;
  if (typeof kind !== 'string') return null;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;
  const name = meta['name'];
  const namespace = meta['namespace'];
  if (typeof name !== 'string') return null;
  return {
    apiVersion,
    kind,
    namespace: typeof namespace === 'string' ? namespace : 'default',
    name,
  };
}

function formatZodError(error: z.ZodError, kind: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    return `  at ${path}: ${issue.message}`;
  });
  return `${kind} validation failed:\n${lines.join('\n')}`;
}
