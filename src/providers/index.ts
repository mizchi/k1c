import { ProviderRegistry } from './registry.ts';
import { workerProvider } from './worker.ts';
import { r2BucketProvider } from './r2-bucket.ts';
import { kvNamespaceProvider } from './kv-namespace.ts';
import { configMapProvider } from './configmap.ts';
import { secretProvider } from './secret.ts';
import { dispatchNamespaceProvider } from './dispatch-namespace.ts';
import { customDomainProvider } from './custom-domain.ts';
import { hyperdriveProvider } from './hyperdrive.ts';
import { d1DatabaseProvider } from './d1-database.ts';
import { queueProvider } from './queue.ts';
import { vectorizeProvider } from './vectorize.ts';
import { dnsRecordProvider } from './dns-record.ts';
import { workflowProvider } from './workflow.ts';

export function createDefaultRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(workerProvider);
  r.register(r2BucketProvider);
  r.register(kvNamespaceProvider);
  r.register(configMapProvider);
  r.register(secretProvider);
  r.register(dispatchNamespaceProvider);
  r.register(customDomainProvider);
  r.register(hyperdriveProvider);
  r.register(d1DatabaseProvider);
  r.register(queueProvider);
  r.register(vectorizeProvider);
  r.register(dnsRecordProvider);
  r.register(workflowProvider);
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
