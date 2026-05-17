import { ProviderRegistry } from './registry.ts';
import { workerProvider } from './worker.ts';
import { r2BucketProvider } from './r2-bucket.ts';
import { kvNamespaceProvider } from './kv-namespace.ts';
import { configMapProvider } from './configmap.ts';
import { secretProvider } from './secret.ts';
import { dispatchNamespaceProvider } from './dispatch-namespace.ts';
import { aiGatewayProvider } from './ai-gateway.ts';
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
import { uriRewriteRuleProvider } from './uri-rewrite-rule.ts';
import { responseHeaderRuleProvider } from './response-header-rule.ts';
import { pageRuleProvider } from './page-rule.ts';
import { streamLiveInputProvider } from './stream-live-input.ts';
import { workerCronTriggerProvider } from './worker-cron-trigger.ts';
import { r2BucketCorsProvider } from './r2-bucket-cors.ts';
import { r2BucketLifecycleProvider } from './r2-bucket-lifecycle.ts';
import { r2BucketEventNotificationProvider } from './r2-bucket-event-notification.ts';
import { r2CustomDomainProvider } from './r2-custom-domain.ts';
import { workerVersionProvider } from './worker-version.ts';
import { workerDeploymentProvider } from './worker-deployment.ts';
import { turnstileWidgetProvider } from './turnstile-widget.ts';
import { snippetProvider } from './snippet.ts';
import { streamKeyProvider } from './stream-key.ts';
import { streamWatermarkProvider } from './stream-watermark.ts';
import { zoneProvider } from './zone.ts';
import { zoneSettingProvider } from './zone-setting.ts';
import { loadBalancerMonitorProvider } from './load-balancer-monitor.ts';
import { loadBalancerPoolProvider } from './load-balancer-pool.ts';
import { loadBalancerProvider } from './load-balancer.ts';
import { notificationPolicyProvider } from './notification-policy.ts';
import { certificatePackProvider } from './certificate-pack.ts';
import { webAnalyticsSiteProvider } from './web-analytics-site.ts';

export function createDefaultRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(workerProvider);
  r.register(r2BucketProvider);
  r.register(kvNamespaceProvider);
  r.register(configMapProvider);
  r.register(secretProvider);
  r.register(dispatchNamespaceProvider);
  r.register(aiGatewayProvider);
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
  r.register(uriRewriteRuleProvider);
  r.register(responseHeaderRuleProvider);
  r.register(pageRuleProvider);
  r.register(streamLiveInputProvider);
  r.register(workerCronTriggerProvider);
  r.register(r2BucketCorsProvider);
  r.register(r2BucketLifecycleProvider);
  r.register(r2BucketEventNotificationProvider);
  r.register(r2CustomDomainProvider);
  r.register(workerVersionProvider);
  r.register(workerDeploymentProvider);
  r.register(turnstileWidgetProvider);
  r.register(snippetProvider);
  r.register(streamKeyProvider);
  r.register(streamWatermarkProvider);
  r.register(zoneProvider);
  r.register(zoneSettingProvider);
  r.register(loadBalancerMonitorProvider);
  r.register(loadBalancerPoolProvider);
  r.register(loadBalancerProvider);
  r.register(notificationPolicyProvider);
  r.register(certificatePackProvider);
  r.register(webAnalyticsSiteProvider);
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
