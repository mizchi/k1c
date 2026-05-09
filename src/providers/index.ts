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
import { logpushJobProvider } from './logpush-job.ts';
import { workerRouteProvider } from './worker-route.ts';
import { accessApplicationProvider } from './access-application.ts';
import { cacheRuleProvider } from './cache-rule.ts';
import { accessPolicyProvider } from './access-policy.ts';
import { transformRuleProvider } from './transform-rule.ts';
import { wafCustomRuleProvider } from './waf-custom-rule.ts';
import { rateLimitRuleProvider } from './rate-limit-rule.ts';
import { customHostnameProvider } from './custom-hostname.ts';
import { wafManagedRulesetProvider } from './waf-managed-ruleset.ts';
import { emailRoutingRuleProvider } from './email-routing-rule.ts';

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
  r.register(logpushJobProvider);
  r.register(workerRouteProvider);
  r.register(accessApplicationProvider);
  r.register(cacheRuleProvider);
  r.register(accessPolicyProvider);
  r.register(transformRuleProvider);
  r.register(wafCustomRuleProvider);
  r.register(rateLimitRuleProvider);
  r.register(customHostnameProvider);
  r.register(wafManagedRulesetProvider);
  r.register(emailRoutingRuleProvider);
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
