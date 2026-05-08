import type Cloudflare from 'cloudflare';
import type { ZodSchema } from 'zod';

export interface ProviderContext {
  readonly cloudflare: Cloudflare;
  readonly accountId: string;
  readonly zoneId?: string;
  readonly namespace: string;
  readonly managedByLabel: string;
  readonly signal: AbortSignal;
  /**
   * Read a local asset file (Worker entrypoint, etc.). Defaults to fs/promises.readFile.
   * Tests inject a stub to avoid filesystem coupling.
   */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export interface ListedResource {
  readonly nativeId: string;
  readonly label: string;
}

export const NotFound = Symbol('NotFound');
export type NotFound = typeof NotFound;

export type CreateResult =
  | { readonly kind: 'sync'; readonly nativeId: string; readonly properties: unknown }
  | { readonly kind: 'async'; readonly nativeId: string; readonly opId: string };

export type UpdateResult = CreateResult | { readonly kind: 'noop' };

export type DeleteResult =
  | { readonly kind: 'sync' }
  | { readonly kind: 'async'; readonly opId: string };

export type StatusResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'success'; readonly properties: unknown }
  | { readonly kind: 'failure'; readonly error: ProviderError };

export type ProviderErrorCode =
  | 'Throttling'
  | 'NotStabilized'
  | 'NetworkFailure'
  | 'ServiceInternalError'
  | 'ServiceTimeout'
  | 'AccessDenied'
  | 'NotUpdatable'
  | 'AlreadyExists'
  | 'NotFound'
  | 'InvalidRequest';

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly recoverable: boolean;
  readonly suggest?: 'recreate';
  readonly message: string;
  readonly cause?: unknown;
}

export const RECOVERABLE_CODES = new Set<ProviderErrorCode>([
  'Throttling',
  'NotStabilized',
  'NetworkFailure',
  'ServiceInternalError',
  'ServiceTimeout',
]);

export function isRecoverable(code: ProviderErrorCode): boolean {
  return RECOVERABLE_CODES.has(code);
}

export interface CloudflareResourceProvider<P> {
  readonly resourceType: string;
  readonly schema: ZodSchema<P>;

  list(ctx: ProviderContext): AsyncIterable<ListedResource>;
  read(ctx: ProviderContext, nativeId: string): Promise<P | NotFound>;

  create(ctx: ProviderContext, label: string, desired: P): Promise<CreateResult>;
  update(
    ctx: ProviderContext,
    nativeId: string,
    prior: P,
    desired: P,
  ): Promise<UpdateResult>;
  delete(ctx: ProviderContext, nativeId: string): Promise<DeleteResult>;

  status?(
    ctx: ProviderContext,
    nativeId: string,
    opId: string,
  ): Promise<StatusResult>;
}
