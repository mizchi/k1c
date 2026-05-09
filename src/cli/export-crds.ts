import process from 'node:process';
import { stringify as stringifyYaml } from 'yaml';
import type { ExportCrdsArgs } from './args.ts';
import { listKinds } from '../manifest/schemas.ts';

/**
 * Emit Kubernetes CRD definitions for every k1c kind under
 * `cloudflare.k1c.io/v1alpha1`. The point is *not* to publish a complete
 * OpenAPI schema (zod → OpenAPI conversion is its own project) — it's just
 * to get k1c manifests through `kubectl apply --dry-run=server` against a
 * real cluster. So each CRD declares the kind name and accepts arbitrary
 * spec fields via `x-kubernetes-preserve-unknown-fields: true`.
 *
 * Standard k8s kinds (Deployment / Service / ConfigMap / Secret / Ingress /
 * StatefulSet / CronJob / Job / Namespace) are NOT emitted by default —
 * those are already part of any k8s install. `--include-standard` adds
 * empty CRD-style stubs anyway, useful for fully-isolated apiserver-less
 * validators.
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

function buildCrd(kind: string): unknown {
  const plural = pluralize(kind);
  const singular = kind.toLowerCase();
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
          schema: {
            openAPIV3Schema: {
              type: 'object',
              // Permissive validation: rely on k1c's zod schema for real
              // checks; the CRD just gates on kind + apiVersion + group.
              'x-kubernetes-preserve-unknown-fields': true,
            },
          },
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
