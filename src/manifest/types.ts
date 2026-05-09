export interface ObjectMeta {
  readonly name: string;
  readonly namespace?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface BaseResource<Kind extends string, ApiVersion extends string, Spec> {
  readonly apiVersion: ApiVersion;
  readonly kind: Kind;
  readonly metadata: ObjectMeta;
  readonly spec: Spec;
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env?: ReadonlyArray<EnvVar>;
  readonly volumeMounts?: ReadonlyArray<VolumeMount>;
}

export interface EnvVar {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: EnvVarSource;
}

export interface EnvVarSource {
  readonly configMapKeyRef?: { readonly name: string; readonly key: string };
  readonly secretKeyRef?: { readonly name: string; readonly key: string };
}

export interface VolumeMount {
  readonly name: string;
  readonly mountPath: string;
}

export interface Volume {
  readonly name: string;
  readonly r2BucketRef?: { readonly name: string };
  readonly kvNamespaceRef?: { readonly name: string };
  readonly serviceRef?: { readonly name: string };
  readonly hyperdriveRef?: { readonly name: string };
  readonly d1DatabaseRef?: { readonly name: string };
  readonly queueRef?: { readonly name: string };
  readonly vectorizeRef?: { readonly name: string };
  readonly analyticsEngineRef?: { readonly dataset: string };
  readonly mtlsCertificateRef?: { readonly certificateId: string };
  readonly pipelinesRef?: { readonly pipelineId: string };
}

export interface PodTemplateSpec {
  readonly metadata?: ObjectMeta;
  readonly spec: PodSpec;
}

export interface PodSpec {
  readonly containers: ReadonlyArray<ContainerSpec>;
  readonly volumes?: ReadonlyArray<Volume>;
}

export interface DeploymentSpec {
  readonly replicas?: number;
  readonly selector: { readonly matchLabels: Readonly<Record<string, string>> };
  readonly template: PodTemplateSpec;
}

export type Deployment = BaseResource<'Deployment', 'apps/v1', DeploymentSpec>;

export interface StatefulSetSpec {
  readonly replicas?: number;
  readonly serviceName?: string;
  readonly selector: { readonly matchLabels: Readonly<Record<string, string>> };
  readonly template: PodTemplateSpec;
}

export type StatefulSet = BaseResource<'StatefulSet', 'apps/v1', StatefulSetSpec>;

export interface BlueGreenStrategy {
  readonly autoPromotionEnabled?: boolean;
  readonly scaleDownDelaySeconds?: number;
}

export interface CanaryStrategy {
  readonly steps: ReadonlyArray<CanaryStep>;
}

export type CanaryStep =
  | { readonly setWeight: number }
  | { readonly pause: { readonly duration?: string } };

export type RolloutStrategy =
  | { readonly blueGreen: BlueGreenStrategy }
  | { readonly canary: CanaryStrategy };

export interface RolloutSpec {
  readonly replicas?: number;
  readonly selector: { readonly matchLabels: Readonly<Record<string, string>> };
  readonly template: PodTemplateSpec;
  readonly strategy: RolloutStrategy;
}

export type Rollout = BaseResource<'Rollout', 'argoproj.io/v1alpha1', RolloutSpec>;

export interface JobTemplateSpec {
  readonly spec: { readonly template: PodTemplateSpec };
}

export interface CronJobSpec {
  readonly schedule: string;
  readonly jobTemplate: JobTemplateSpec;
  readonly successfulJobsHistoryLimit?: number;
  readonly failedJobsHistoryLimit?: number;
  readonly suspend?: boolean;
}

export type CronJob = BaseResource<'CronJob', 'batch/v1', CronJobSpec>;

export interface ConfigMapResource extends BaseResource<'ConfigMap', 'v1', never> {
  readonly data?: Readonly<Record<string, string>>;
}

export interface SecretResource extends BaseResource<'Secret', 'v1', never> {
  readonly type?: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly stringData?: Readonly<Record<string, string>>;
}

export interface NamespaceResource extends BaseResource<'Namespace', 'v1', never> {}

export interface ServicePort {
  readonly port: number;
  readonly targetPort?: number;
  readonly name?: string;
  readonly protocol?: 'TCP' | 'UDP';
}

export interface ServiceSpec {
  readonly type?: 'ClusterIP' | 'LoadBalancer';
  readonly selector: Readonly<Record<string, string>>;
  readonly ports?: ReadonlyArray<ServicePort>;
}

export type ServiceResource = BaseResource<'Service', 'v1', ServiceSpec>;

export interface R2BucketSpec {
  readonly location?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
  readonly storageClass?: 'Standard' | 'InfrequentAccess';
}

export type R2Bucket = BaseResource<
  'R2Bucket',
  'cloudflare.k1c.io/v1alpha1',
  R2BucketSpec
>;

export interface KVNamespaceSpec {
  readonly title?: string;
}

export type KVNamespace = BaseResource<
  'KVNamespace',
  'cloudflare.k1c.io/v1alpha1',
  KVNamespaceSpec
>;

export interface DispatchNamespaceSpec {
  // Empty for v0.1.2; future: hooks for compatibility config, default observability.
  readonly _placeholder?: never;
}

export type DispatchNamespace = BaseResource<
  'DispatchNamespace',
  'cloudflare.k1c.io/v1alpha1',
  DispatchNamespaceSpec
>;

export type HyperdriveScheme = 'postgres' | 'postgresql' | 'mysql';

export interface HyperdriveOrigin {
  readonly scheme: HyperdriveScheme;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** The password value is read from the referenced Secret at lower time. */
  readonly passwordSecretRef: { readonly name: string; readonly key: string };
}

export interface HyperdriveCaching {
  readonly disabled?: boolean;
  readonly maxAge?: number;
  readonly staleWhileRevalidate?: number;
}

export interface HyperdriveSpec {
  readonly origin: HyperdriveOrigin;
  readonly caching?: HyperdriveCaching;
  readonly originConnectionLimit?: number;
}

export type Hyperdrive = BaseResource<'Hyperdrive', 'cloudflare.k1c.io/v1alpha1', HyperdriveSpec>;

export interface D1DatabaseSpec {
  readonly primaryLocationHint?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
}

export type D1Database = BaseResource<
  'D1Database',
  'cloudflare.k1c.io/v1alpha1',
  D1DatabaseSpec
>;

export interface QueueSpec {
  /** Optional consumer Worker (referenced by name). The dispatched Worker must exist
   *  in the same namespace and is wired via `cloudflare.workers.queues.consumers`. */
  readonly consumer?: { readonly workerName: string };
}

export type Queue = BaseResource<'Queue', 'cloudflare.k1c.io/v1alpha1', QueueSpec>;

export interface VectorizeSpec {
  readonly dimensions: number;
  readonly metric: 'cosine' | 'euclidean' | 'dot-product';
  readonly description?: string;
}

export type Vectorize = BaseResource<
  'Vectorize',
  'cloudflare.k1c.io/v1alpha1',
  VectorizeSpec
>;

export interface DNSRecordSpec {
  readonly zoneId: string;
  readonly type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
  readonly name: string;
  readonly content: string;
  readonly ttl?: number;
  readonly proxied?: boolean;
  readonly priority?: number;
}

export type DNSRecord = BaseResource<'DNSRecord', 'cloudflare.k1c.io/v1alpha1', DNSRecordSpec>;

export interface JobSpec {
  readonly template: PodTemplateSpec;
  readonly backoffLimit?: number;
  readonly activeDeadlineSeconds?: number;
  readonly completions?: number;
  readonly parallelism?: number;
}

export type Job = BaseResource<'Job', 'batch/v1', JobSpec>;

export interface LogpushJobSpec {
  /** Either zoneId or accountId is required (mutually exclusive). */
  readonly zoneId?: string;
  readonly accountId?: string;
  readonly dataset:
    | 'http_requests'
    | 'workers_trace_events'
    | 'firewall_events'
    | 'access_requests'
    | 'audit_logs'
    | 'dns_logs'
    | 'spectrum_events'
    | 'nel_reports'
    | 'gateway_dns'
    | 'gateway_http'
    | 'gateway_network'
    | 'magic_ids_detections'
    | 'network_analytics_logs';
  readonly destinationConf: string;
  readonly enabled?: boolean;
  readonly filter?: string;
}

export type LogpushJob = BaseResource<'LogpushJob', 'cloudflare.k1c.io/v1alpha1', LogpushJobSpec>;

export type IngressPathType = 'Prefix' | 'Exact' | 'ImplementationSpecific';

export interface IngressBackend {
  readonly service: { readonly name: string; readonly port?: { readonly number?: number; readonly name?: string } };
}

export interface IngressPath {
  readonly path: string;
  readonly pathType: IngressPathType;
  readonly backend: IngressBackend;
}

export interface IngressRule {
  readonly host?: string;
  readonly http: { readonly paths: ReadonlyArray<IngressPath> };
}

export interface IngressSpec {
  readonly rules: ReadonlyArray<IngressRule>;
  readonly defaultBackend?: IngressBackend;
}

export type Ingress = BaseResource<'Ingress', 'networking.k8s.io/v1', IngressSpec>;

export type AccessDecision = 'allow' | 'deny' | 'bypass' | 'non_identity';

export type AccessRule =
  | { readonly email: { readonly email: string } }
  | { readonly emailDomain: { readonly domain: string } }
  | { readonly everyone: Readonly<Record<string, never>> }
  | { readonly ip: { readonly ip: string } }
  | { readonly country: { readonly code: string } }
  | { readonly serviceToken: { readonly tokenId: string } }
  | { readonly anyValidServiceToken: Readonly<Record<string, never>> };

export interface AccessAppPolicy {
  readonly name: string;
  readonly decision: AccessDecision;
  readonly include: ReadonlyArray<AccessRule>;
  readonly exclude?: ReadonlyArray<AccessRule>;
  readonly require?: ReadonlyArray<AccessRule>;
  readonly sessionDuration?: string;
}

export interface AccessPolicyRef {
  /** Name of an AccessPolicy resource in the same namespace. */
  readonly ref: string;
}

export type AccessApplicationPolicyItem = AccessAppPolicy | AccessPolicyRef;

export type AccessApplicationType =
  | 'self_hosted'
  | 'ssh'
  | 'vnc'
  | 'biso'
  | 'saas'
  | 'infrastructure'
  | 'bookmark';

export interface AccessApplicationSpec {
  readonly domain: string;
  /**
   * Cloudflare Access application type. Defaults to `self_hosted`.
   *
   *   - `self_hosted` / `ssh` / `vnc` / `biso` (Browser Isolation): share the
   *     base shape (domain + policies + IdP config).
   *   - `saas`: domain is the user-visible app name; the IdP-side SAML / OIDC
   *     config is passed through verbatim as `saasApp`.
   *   - `infrastructure`: target connector list passed through as `targetCriteria`.
   *   - `bookmark`: App Launcher tile only — no policies, instead `logoUrl` /
   *     `appLauncherVisible`.
   */
  readonly type?: AccessApplicationType;
  readonly sessionDuration?: string;
  readonly autoRedirectToIdentity?: boolean;
  readonly allowedIdps?: ReadonlyArray<string>;
  /**
   * Required (>=1) for everything except `bookmark`, which must have zero.
   * The schema enforces both rules.
   */
  readonly policies?: ReadonlyArray<AccessApplicationPolicyItem>;
  /** Bookmark only: image URL shown on the App Launcher tile. */
  readonly logoUrl?: string;
  /** Show in the App Launcher dashboard. Applies to non-bookmark types too. */
  readonly appLauncherVisible?: boolean;
  /**
   * SaaS-only. Raw `saas_app` payload passed through to the Cloudflare API
   * verbatim (SAML or OIDC config). Schema is intentionally untyped at this
   * layer — k1c does not currently model the protocol-specific fields.
   */
  readonly saasApp?: Readonly<Record<string, unknown>>;
  /**
   * Infrastructure-only. Raw `target_criteria` payload (an array of target
   * connector descriptors) passed through verbatim.
   */
  readonly targetCriteria?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface AccessPolicySpec {
  readonly decision: AccessDecision;
  readonly include: ReadonlyArray<AccessRule>;
  readonly exclude?: ReadonlyArray<AccessRule>;
  readonly require?: ReadonlyArray<AccessRule>;
  readonly sessionDuration?: string;
}

export type AccessPolicy = BaseResource<
  'AccessPolicy',
  'cloudflare.k1c.io/v1alpha1',
  AccessPolicySpec
>;

export type AccessApplication = BaseResource<
  'AccessApplication',
  'cloudflare.k1c.io/v1alpha1',
  AccessApplicationSpec
>;

export type CacheRuleTtlMode = 'respect_origin' | 'bypass_by_default' | 'override_origin';

export interface CacheRuleTtl {
  readonly mode: CacheRuleTtlMode;
  readonly default?: number;
}

export interface CacheRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly cache: boolean;
  readonly enabled?: boolean;
  readonly edgeTtl?: CacheRuleTtl;
  readonly browserTtl?: CacheRuleTtl;
  /** Free-form description shown in the dashboard alongside the k1c ownership marker. */
  readonly description?: string;
}

export type CacheRule = BaseResource<'CacheRule', 'cloudflare.k1c.io/v1alpha1', CacheRuleSpec>;

export type TransformHeaderOperation = 'set' | 'add' | 'remove';

export interface TransformHeaderAction {
  readonly operation: TransformHeaderOperation;
  readonly value?: string;
}

export interface TransformRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled?: boolean;
  readonly headers: Readonly<Record<string, TransformHeaderAction>>;
  readonly description?: string;
}

export type TransformRule = BaseResource<
  'TransformRule',
  'cloudflare.k1c.io/v1alpha1',
  TransformRuleSpec
>;

export type WAFAction =
  | 'block'
  | 'challenge'
  | 'managed_challenge'
  | 'js_challenge'
  | 'log'
  | 'skip';

export interface WAFCustomRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly action: WAFAction;
  readonly enabled?: boolean;
  readonly description?: string;
}

export type WAFCustomRule = BaseResource<
  'WAFCustomRule',
  'cloudflare.k1c.io/v1alpha1',
  WAFCustomRuleSpec
>;

export type RateLimitAction = 'block' | 'managed_challenge' | 'js_challenge' | 'log';

export interface RateLimitConfig {
  readonly characteristics: ReadonlyArray<string>;
  readonly period: number;
  readonly requestsPerPeriod: number;
  readonly mitigationTimeout?: number;
  readonly countingExpression?: string;
  readonly requestsToOrigin?: boolean;
}

export interface RateLimitRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly action: RateLimitAction;
  readonly enabled?: boolean;
  readonly ratelimit: RateLimitConfig;
  readonly description?: string;
}

export type RateLimitRule = BaseResource<
  'RateLimitRule',
  'cloudflare.k1c.io/v1alpha1',
  RateLimitRuleSpec
>;

export interface CustomHostnameSpec {
  readonly zoneId: string;
  readonly hostname: string;
  readonly ssl?: {
    readonly method?: 'http' | 'cname' | 'txt' | 'email';
    readonly type?: 'dv';
  };
}

export type CustomHostname = BaseResource<
  'CustomHostname',
  'cloudflare.k1c.io/v1alpha1',
  CustomHostnameSpec
>;

export type WAFManagedOverrideAction =
  | 'block'
  | 'challenge'
  | 'managed_challenge'
  | 'js_challenge'
  | 'log';

export interface WAFManagedRulesetSpec {
  readonly zoneId: string;
  readonly rulesetId: string;
  readonly enabled?: boolean;
  readonly expression?: string;
  readonly overrideAction?: WAFManagedOverrideAction;
  readonly description?: string;
}

export type WAFManagedRuleset = BaseResource<
  'WAFManagedRuleset',
  'cloudflare.k1c.io/v1alpha1',
  WAFManagedRulesetSpec
>;

export type EmailRoutingMatcher =
  | { readonly type: 'all' }
  | { readonly type: 'literal'; readonly field: 'to'; readonly value: string };

export type EmailRoutingAction =
  | { readonly type: 'drop' }
  | { readonly type: 'forward'; readonly to: ReadonlyArray<string> }
  | { readonly type: 'worker'; readonly worker: string };

export interface EmailRoutingRuleSpec {
  readonly zoneId: string;
  /** User-facing rule name shown in the dashboard (k1c prefixes it for ownership). */
  readonly ruleName: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly matchers: ReadonlyArray<EmailRoutingMatcher>;
  readonly actions: ReadonlyArray<EmailRoutingAction>;
}

export type EmailRoutingRule = BaseResource<
  'EmailRoutingRule',
  'cloudflare.k1c.io/v1alpha1',
  EmailRoutingRuleSpec
>;

export type URIPart =
  | { readonly value: string }
  | { readonly expression: string };

export interface URIRewriteRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled?: boolean;
  readonly path?: URIPart;
  readonly query?: URIPart;
  readonly description?: string;
}

export type URIRewriteRule = BaseResource<
  'URIRewriteRule',
  'cloudflare.k1c.io/v1alpha1',
  URIRewriteRuleSpec
>;

export interface ResponseHeaderRuleSpec {
  readonly zoneId: string;
  readonly expression: string;
  readonly enabled?: boolean;
  readonly headers: Readonly<Record<string, TransformHeaderAction>>;
  readonly description?: string;
}

export type ResponseHeaderRule = BaseResource<
  'ResponseHeaderRule',
  'cloudflare.k1c.io/v1alpha1',
  ResponseHeaderRuleSpec
>;

export type K1cResource =
  | Deployment
  | Rollout
  | StatefulSet
  | CronJob
  | Job
  | ConfigMapResource
  | SecretResource
  | NamespaceResource
  | ServiceResource
  | R2Bucket
  | KVNamespace
  | DispatchNamespace
  | Hyperdrive
  | D1Database
  | Queue
  | Vectorize
  | DNSRecord
  | LogpushJob
  | Ingress
  | AccessApplication
  | AccessPolicy
  | CacheRule
  | TransformRule
  | WAFCustomRule
  | RateLimitRule
  | CustomHostname
  | WAFManagedRuleset
  | EmailRoutingRule
  | URIRewriteRule
  | ResponseHeaderRule;

export type ResourceKind = K1cResource['kind'];

export interface ResourceRef {
  readonly apiVersion: string;
  readonly kind: ResourceKind;
  readonly namespace: string;
  readonly name: string;
}

export function refOf(resource: K1cResource): ResourceRef {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    namespace: resource.metadata.namespace ?? 'default',
    name: resource.metadata.name,
  };
}

export function refKey(ref: ResourceRef): string {
  return `${ref.apiVersion}/${ref.kind}/${ref.namespace}/${ref.name}`;
}
