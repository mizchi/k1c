import { ProviderRegistry } from './registry.ts';
import { workerProvider } from './worker.ts';
import { r2BucketProvider } from './r2-bucket.ts';
import { kvNamespaceProvider } from './kv-namespace.ts';
import { configMapProvider } from './configmap.ts';
import { secretProvider } from './secret.ts';
import { dispatchNamespaceProvider } from './dispatch-namespace.ts';
import { customDomainProvider } from './custom-domain.ts';

export function createDefaultRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(workerProvider);
  r.register(r2BucketProvider);
  r.register(kvNamespaceProvider);
  r.register(configMapProvider);
  r.register(secretProvider);
  r.register(dispatchNamespaceProvider);
  r.register(customDomainProvider);
  return r;
}

export { ProviderRegistry } from './registry.ts';
export type {
  CloudflareResourceProvider,
  ProviderContext,
  CreateResult,
  UpdateResult,
  DeleteResult,
  StatusResult,
  ProviderError,
  ProviderErrorCode,
  ListedResource,
} from './types.ts';
export { NotFound, isRecoverable, RECOVERABLE_CODES } from './types.ts';
