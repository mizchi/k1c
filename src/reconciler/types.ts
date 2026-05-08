import type { ResourceRef } from '../manifest/types.ts';
import type { ProviderError } from '../providers/types.ts';

export interface DesiredResource<P = unknown> {
  readonly resourceType: string;
  readonly ref: ResourceRef;
  readonly label: string;
  readonly properties: P;
  readonly dependsOn?: ReadonlyArray<ResourceRef>;
}

export type Operation =
  | {
      readonly kind: 'create';
      readonly resourceType: string;
      readonly ref: ResourceRef;
      readonly label: string;
      readonly properties: unknown;
    }
  | {
      readonly kind: 'update';
      readonly resourceType: string;
      readonly ref: ResourceRef;
      readonly label: string;
      readonly nativeId: string;
      readonly prior: unknown;
      readonly properties: unknown;
    }
  | {
      readonly kind: 'delete';
      readonly resourceType: string;
      readonly nativeId: string;
      readonly label: string;
    }
  | {
      readonly kind: 'noop';
      readonly resourceType: string;
      readonly ref: ResourceRef;
      readonly label: string;
    };

export type OperationKind = Operation['kind'];

export interface Plan {
  readonly operations: ReadonlyArray<Operation>;
}

export type OperationStatus = 'succeeded' | 'skipped' | 'failed';

export interface OperationResult {
  readonly op: Operation;
  readonly status: OperationStatus;
  readonly nativeId?: string;
  readonly error?: ProviderError;
}

export interface ApplyReport {
  readonly results: ReadonlyArray<OperationResult>;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
}

export function labelOf(ref: ResourceRef): string {
  return `${ref.namespace}/${ref.name}`;
}

export function namespaceFromLabel(label: string): string {
  const idx = label.indexOf('/');
  return idx === -1 ? 'default' : label.slice(0, idx);
}
