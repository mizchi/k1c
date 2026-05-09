import process from 'node:process';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ExportCrdsArgs } from './args.ts';
import { SCHEMAS_BY_KIND, listKinds } from '../manifest/schemas.ts';

/**
 * Emit Kubernetes CRD definitions for every k1c kind under
 * `cloudflare.k1c.io/v1alpha1`. Each CRD's `openAPIV3Schema` is
 * derived from the zod manifest schema via `zod-to-json-schema`,
 * inlined (no $refs) and adapted to Kubernetes Structural Schema
 * rules. That means `kubectl apply` validates `.spec` server-side at
 * apply time — typos / missing required fields fail before they
 * reach the operator.
 *
 * Standard k8s kinds (Deployment / Service / ConfigMap / Secret /
 * Ingress / StatefulSet / CronJob / Job / Namespace) are NOT emitted
 * by default — those are part of any k8s install. `--include-standard`
 * adds permissive CRD-style stubs anyway, for apiserver-less
 * validators that want everything in one bundle.
 */

const STANDARD_KINDS = new Set([
  'Deployment',
  'Service',
  'ConfigMap',
  'Secret',
  'Namespace',
  'Ingress',
  'StatefulSet',
  'CronJob',
  'Job',
  'Rollout', // argoproj.io
]);

const GROUP = 'cloudflare.k1c.io';
const VERSION = 'v1alpha1';

function pluralize(kind: string): string {
  // Naive but matches Cloudflare's inflection: append "s" or "es" for sibilants.
  const lower = kind.toLowerCase();
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) return `${lower}es`;
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * Strip JSON Schema features that the Kubernetes Structural Schema
 * dialect rejects:
 *
 *   - `$schema`                 — meta-only, kubectl rejects unknown
 *   - `additionalProperties: false` at the top of nested objects when
 *                                  it would conflict with our
 *                                  catch-all status field
 *   - `oneOf`/`anyOf`/`allOf`   — only allowed via XValidations; we
 *                                  flatten unions to
 *                                  x-kubernetes-preserve-unknown-fields
 *   - tuple `items` arrays      — kubernetes only supports a single
 *                                  schema for `items`
 *
 * Other features (`enum`, `pattern`, `format`, `required`,
 * `properties`, `type`) pass through unchanged.
 */
function adaptToK8sStructural(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(adaptToK8sStructural);
  const out: Record<string, unknown> = {};
  const obj = node as Record<string, unknown>;
  const hasProperties = 'properties' in obj;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$schema') continue;
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      // k8s rejects schema-form unions in CRDs (without
      // x-kubernetes-validations). Replace with the permissive escape
      // hatch so kubectl accepts the field as-is.
      out['x-kubernetes-preserve-unknown-fields'] = true;
      continue;
    }
    if (key === 'items' && Array.isArray(value)) {
      out['items'] = normalizeNode(adaptToK8sStructural(value[0] ?? {}));
      continue;
    }
    if (key === 'format') {
      // k8s structural schema only allows a known set of formats
      // (date-time, uri, etc.). Drop unknown ones; keep "uri" since
      // it doesn't enforce strict validation server-side.
      if (typeof value === 'string' && value !== 'uri' && value !== 'date-time') {
        continue;
      }
    }
    if (key === 'additionalProperties' && hasProperties) {
      // Kubernetes structural schema forbids combining `properties`
      // with `additionalProperties`. zod-to-json-schema emits
      // `additionalProperties: false` for every closed object —
      // drop it; declared `properties` already implies that nodes
      // outside the list are unknown.
      continue;
    }
    out[key] = adaptToK8sStructural(value);
  }
  return normalizeNode(out);
}

/**
 * Kubernetes structural schema requires every node to declare a
 * `type` (or use the `x-kubernetes-preserve-unknown-fields: true`
 * escape hatch). zod's `z.unknown()` lowers to `{}` (no type) — pass
 * it through the escape hatch so kubectl accepts arbitrary content.
 */
function normalizeNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  const obj = node as Record<string, unknown>;
  // If the node lacks a type AND already has `x-kubernetes-...` we
  // leave it alone; otherwise stamp the preserve-unknown-fields hatch
  // so it's a valid leaf.
  if (
    obj['type'] === undefined &&
    obj['x-kubernetes-preserve-unknown-fields'] === undefined &&
    obj['enum'] === undefined &&
    Object.keys(obj).length === 0
  ) {
    return { 'x-kubernetes-preserve-unknown-fields': true };
  }
  return obj;
}

function specSchemaFor(kind: string): unknown {
  const schema = SCHEMAS_BY_KIND[kind as keyof typeof SCHEMAS_BY_KIND];
  if (!schema) return null;
  // Each k1c kind's schema is z.object({apiVersion, kind, metadata, spec}).
  // Pull the spec ZodType directly so we only emit spec validation;
  // metadata + apiVersion + kind use the standard k8s types.
  const obj = schema as unknown as z.ZodObject<{ spec: z.ZodTypeAny }>;
  const specSchema = obj.shape.spec;
  if (!specSchema) return null;
  const json = zodToJsonSchema(specSchema, {
    target: 'openApi3',
    $refStrategy: 'none',
  });
  return adaptToK8sStructural(json);
}

function buildCrd(kind: string): unknown {
  const plural = pluralize(kind);
  const singular = kind.toLowerCase();
  const specSchema = specSchemaFor(kind);
  // For standard kinds (or anything we couldn't derive), keep the
  // permissive escape hatch.
  // Note: kubernetes forbids declaring `metadata` as a CRD property
  // ("must not specify anything other than name and generateName"),
  // so we leave it out — the apiserver applies the standard ObjectMeta
  // schema to it automatically.
  const openAPIV3Schema =
    specSchema === null
      ? { type: 'object', 'x-kubernetes-preserve-unknown-fields': true }
      : {
          type: 'object',
          properties: {
            apiVersion: { type: 'string' },
            kind: { type: 'string' },
            spec: specSchema,
            status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          },
          required: ['spec'],
        };
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${plural}.${GROUP}`,
    },
    spec: {
      group: GROUP,
      scope: 'Namespaced',
      names: {
        kind,
        singular,
        plural,
        listKind: `${kind}List`,
      },
      versions: [
        {
          name: VERSION,
          served: true,
          storage: true,
          schema: { openAPIV3Schema },
          // Enable the /status subresource so the operator can patch
          // .status.conditions independently of .spec — without this,
          // every status patch would also bump the resource's
          // generation and feed back into the reconcile loop.
          subresources: { status: {} },
        },
      ],
    },
  };
}

export function runExportCrds(args: ExportCrdsArgs): number {
  const out: string[] = [];
  for (const kind of listKinds()) {
    if (!args.includeStandard && STANDARD_KINDS.has(kind)) continue;
    const crd = buildCrd(kind);
    out.push(stringifyYaml(crd));
  }
  process.stdout.write(out.join('---\n'));
  return 0;
}
