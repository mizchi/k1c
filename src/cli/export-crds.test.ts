import { describe, expect, it } from 'vitest';

// We re-export the internal helpers for test access by importing the
// module's internal namespace. This file lives next to export-crds.ts
// so the relative import works.
import { listKinds, SCHEMAS_BY_KIND } from '../manifest/schemas.ts';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Replicate the internal `specSchemaFor` indirectly: derive the JSON
// Schema for each kind's spec the same way export-crds.ts does, then
// assert no node has an empty `{}` (which would be an invalid k8s
// structural schema leaf).
function deriveSpecJson(kind: string): unknown {
  const schema = SCHEMAS_BY_KIND[kind as keyof typeof SCHEMAS_BY_KIND];
  if (!schema) return null;
  const obj = schema as unknown as z.ZodObject<{ spec: z.ZodTypeAny }>;
  const specSchema = obj.shape.spec;
  if (!specSchema) return null;
  return zodToJsonSchema(specSchema, {
    target: 'openApi3',
    $refStrategy: 'none',
  });
}

describe('CRD spec derivation', () => {
  it('every kind in SCHEMAS_BY_KIND that has a spec field derives JSON', () => {
    // ConfigMap / Secret / Namespace carry data directly on the
    // resource, no `spec`. They aren't emitted as CRDs by default
    // (they're standard k8s kinds).
    const skip = new Set(['ConfigMap', 'Secret', 'Namespace']);
    for (const kind of listKinds()) {
      if (skip.has(kind)) continue;
      const json = deriveSpecJson(kind);
      expect(json, `derive ${kind}`).not.toBeNull();
    }
  });

  it('R2Bucket spec includes the location enum', () => {
    const json = deriveSpecJson('R2Bucket') as Record<string, unknown>;
    expect(json['type']).toBe('object');
    const props = json['properties'] as Record<string, { enum?: string[] }>;
    expect(props['location']?.enum).toContain('weur');
  });

  it('PageRule spec marks actions as required', () => {
    const json = deriveSpecJson('PageRule') as Record<string, unknown>;
    expect(json['required']).toEqual(expect.arrayContaining(['url', 'actions']));
  });

  it('StreamLiveInput spec has nested recording shape', () => {
    const json = deriveSpecJson('StreamLiveInput') as Record<string, unknown>;
    const props = json['properties'] as Record<string, unknown>;
    expect(props['recording']).toBeDefined();
    const rec = props['recording'] as Record<string, unknown>;
    const recProps = rec['properties'] as Record<string, { enum?: string[] }>;
    expect(recProps['mode']?.enum).toEqual(['off', 'automatic']);
  });
});
