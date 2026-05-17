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

/**
 * Volume source modeled on k8s `Pod.spec.volumes[]` so a k1c manifest passes
 * `kubectl apply --dry-run=server`. Cloudflare-specific bindings (R2 / KV /
 * D1 / Hyperdrive / Vectorize / Queue / Service binding / etc.) ride on the
 * standard `csi` field with a k1c-specific driver name. CSI is part of the
 * upstream PodSpec schema, so admission controllers validate it without
 * complaint — the Cloudflare CSI drivers just never exist on a real cluster,
 * so the Pod stays pending. k1c reads the driver + volumeAttributes directly
 * to wire the corresponding Worker binding.
 */
export interface CSIVolumeSource {
  readonly driver: string;
  /**
   * Driver-specific refs plus an optional Worker binding name. `binding` is
   * preferred; `bindingName` remains accepted for older manifests. When omitted,
   * k1c derives one from the volume name (`r2-media` -> `R2_MEDIA`).
   */
  readonly volumeAttributes?: Readonly<Record<string, string>>;
}

export interface Volume {
  readonly name: string;
  readonly csi?: CSIVolumeSource;
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

export interface AIGatewaySpec {
  /** Optional literal Gateway ID. Defaults to k1c-<namespace>-<name>. */
  readonly id?: string;
  readonly cacheInvalidateOnUpdate?: boolean;
  readonly cacheTtl?: number | null;
  readonly collectLogs?: boolean;
  readonly rateLimiting?: {
    readonly interval?: number | null;
    readonly limit?: number | null;
    readonly technique?: 'fixed' | 'sliding';
  };
  readonly authentication?: boolean;
  readonly logManagement?: {
    readonly retention?: number | null;
    readonly strategy?: 'STOP_INSERTING' | 'DELETE_OLDEST' | null;
  };
  readonly logpush?: {
    readonly enabled?: boolean;
    readonly publicKey?: string | null;
  };
}

export type AIGateway = BaseResource<
  'AIGateway',
  'cloudflare.k1c.io/v1alpha1',
  AIGatewaySpec
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

export interface TelemetryStreamSpec {
  readonly enabled?: boolean;
  /**
   * Cloudflare Logpush destination — `r2://...`, `s3://...`, `https://...`,
   * etc. Mutually exclusive with `viaAggregator: true`.
   */
  readonly destination?: string;
  /**
   * Route this stream through the TelemetryStack's aggregator Worker
   * instead of using a static destination. Cannot be combined with
   * `destination`.
   */
  readonly viaAggregator?: boolean;
  /** Optional Logpush filter (JSON-encoded predicate). */
  readonly filter?: string;
}

export interface TelemetryAggregatorSpec {
  /** Public hostname the Logpush HTTP target points at. */
  readonly hostname: string;
  /** Existing k1c-managed Queue (metadata.name). Bound as env.QUEUE. */
  readonly queueRef?: string;
  /** Existing k1c-managed R2Bucket (metadata.name). Bound as env.SINK_R2. */
  readonly r2Ref?: string;
  /** OTLP collector URL set on the Worker as env.OTLP_URL. */
  readonly otlpUrl?: string;
  /** Secret carrying the LOGPUSH_HMAC verification key. */
  readonly hmacSecretRef?: { readonly name: string; readonly key: string };
}

export interface TelemetryStackSpec {
  /** Zone id used for zone-scoped streams (`httpRequests`, `firewallEvents`, `dnsLogs`). */
  readonly zoneId?: string;
  readonly workersTrace?: TelemetryStreamSpec;
  readonly httpRequests?: TelemetryStreamSpec;
  readonly firewallEvents?: TelemetryStreamSpec;
  readonly dnsLogs?: TelemetryStreamSpec;
  readonly auditLogs?: TelemetryStreamSpec;
  /**
   * Optional in-edge aggregator. When set, k1c generates a Worker that
   * receives Logpush HTTP POSTs and fans them out (Queue / R2 / OTLP).
   * Streams with `viaAggregator: true` ship to the aggregator's hostname
   * instead of their own destination.
   */
  readonly aggregator?: TelemetryAggregatorSpec;
}

export type TelemetryStack = BaseResource<
  'TelemetryStack',
  'cloudflare.k1c.io/v1alpha1',
  TelemetryStackSpec
>;

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

export interface PageRuleAction {
  readonly id: string;
  readonly value?: unknown;
}

export interface PageRuleSpec {
  readonly zoneId?: string;
  readonly url: string;
  readonly status?: 'active' | 'disabled';
  readonly priority?: number;
  readonly actions: ReadonlyArray<PageRuleAction>;
}

export type PageRule = BaseResource<'PageRule', 'cloudflare.k1c.io/v1alpha1', PageRuleSpec>;

export interface LiveInputRecording {
  readonly mode?: 'off' | 'automatic';
  readonly requireSignedURLs?: boolean;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly hideLiveViewerCount?: boolean;
  readonly timeoutSeconds?: number;
}

export interface StreamLiveInputSpec {
  readonly defaultCreator?: string;
  readonly deleteRecordingAfterDays?: number;
  readonly recording?: LiveInputRecording;
  readonly meta?: Readonly<Record<string, string>>;
}

export type StreamLiveInput = BaseResource<
  'StreamLiveInput',
  'cloudflare.k1c.io/v1alpha1',
  StreamLiveInputSpec
>;

export interface WorkerCronTriggerSpec {
  /** Cloudflare Worker script name to attach the cron triggers to. */
  readonly scriptName: string;
  /** Cron expressions (standard 5-field format, UTC). Empty array removes all triggers. */
  readonly schedules: ReadonlyArray<string>;
}

export type WorkerCronTrigger = BaseResource<
  'WorkerCronTrigger',
  'cloudflare.k1c.io/v1alpha1',
  WorkerCronTriggerSpec
>;

export type R2CorsMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';

export interface R2BucketCorsSpec {
  readonly bucketName: string;
  readonly rules: ReadonlyArray<{
    readonly id?: string;
    readonly allowed: {
      readonly methods: ReadonlyArray<R2CorsMethod>;
      readonly origins: ReadonlyArray<string>;
      readonly headers?: ReadonlyArray<string>;
    };
    readonly exposeHeaders?: ReadonlyArray<string>;
    readonly maxAgeSeconds?: number;
  }>;
}

export type R2BucketCors = BaseResource<
  'R2BucketCors',
  'cloudflare.k1c.io/v1alpha1',
  R2BucketCorsSpec
>;

export type R2LifecycleAgeCondition = { readonly type: 'Age'; readonly maxAge: number };
export type R2LifecycleDateCondition = { readonly type: 'Date'; readonly date: string };

export interface R2BucketLifecycleSpec {
  readonly bucketName: string;
  readonly rules: ReadonlyArray<{
    readonly id: string;
    readonly enabled: boolean;
    readonly conditions: { readonly prefix: string };
    readonly abortMultipartUploadsTransition?: { readonly condition?: R2LifecycleAgeCondition };
    readonly deleteObjectsTransition?: {
      readonly condition?: R2LifecycleAgeCondition | R2LifecycleDateCondition;
    };
    readonly storageClassTransitions?: ReadonlyArray<{
      readonly condition: R2LifecycleAgeCondition | R2LifecycleDateCondition;
      readonly storageClass: 'InfrequentAccess';
    }>;
  }>;
}

export type R2BucketLifecycle = BaseResource<
  'R2BucketLifecycle',
  'cloudflare.k1c.io/v1alpha1',
  R2BucketLifecycleSpec
>;

export type R2EventAction =
  | 'PutObject'
  | 'CopyObject'
  | 'DeleteObject'
  | 'CompleteMultipartUpload'
  | 'LifecycleDeletion';

export interface R2BucketEventNotificationSpec {
  readonly bucketName: string;
  /** Queue id (UUID) of the destination Cloudflare Queue. */
  readonly queueId: string;
  readonly rules: ReadonlyArray<{
    readonly actions: ReadonlyArray<R2EventAction>;
    readonly prefix?: string;
    readonly suffix?: string;
    readonly description?: string;
  }>;
}

export type R2BucketEventNotification = BaseResource<
  'R2BucketEventNotification',
  'cloudflare.k1c.io/v1alpha1',
  R2BucketEventNotificationSpec
>;

export interface R2CustomDomainSpec {
  readonly bucketName: string;
  readonly domain: string;
  readonly zoneId: string;
  readonly enabled: boolean;
  readonly minTLS?: '1.0' | '1.1' | '1.2' | '1.3';
}

export type R2CustomDomain = BaseResource<
  'R2CustomDomain',
  'cloudflare.k1c.io/v1alpha1',
  R2CustomDomainSpec
>;

/**
 * Subset of WorkerProperties that the manifest exposes for a versioned
 * upload — same shape as the inline `script` field on a Worker but
 * surfaced explicitly here so the manifest schema can declare it.
 */
export interface WorkerVersionSpec {
  readonly scriptName: string;
  readonly versionTag: string;
  readonly message?: string;
  readonly entrypoint?: string;
  readonly entrypointContent?: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
  readonly vars?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly observability?: { readonly enabled: boolean };
}

export type WorkerVersion = BaseResource<
  'WorkerVersion',
  'cloudflare.k1c.io/v1alpha1',
  WorkerVersionSpec
>;

export interface WorkerDeploymentSpec {
  readonly scriptName: string;
  readonly message?: string;
  readonly versions: ReadonlyArray<{
    /**
     * Cloudflare version id — typically a placeholder string
     * `<resolved-at-apply:WorkerVersion:ns/name>` that k1c rewrites to
     * the real id at apply time using the resolution cache.
     */
    readonly versionId: string;
    readonly percentage: number;
  }>;
}

export type WorkerDeployment = BaseResource<
  'WorkerDeployment',
  'cloudflare.k1c.io/v1alpha1',
  WorkerDeploymentSpec
>;

export interface TurnstileWidgetSpec {
  /** Display name. The provider prefixes with `k1c-<ns>-<name>` when not set explicitly. */
  readonly widgetName?: string;
  readonly domains: ReadonlyArray<string>;
  readonly mode: 'non-interactive' | 'invisible' | 'managed';
  readonly botFightMode?: boolean;
  readonly clearanceLevel?: 'no_clearance' | 'jschallenge' | 'managed' | 'interactive';
  readonly ephemeralId?: boolean;
  readonly offlabel?: boolean;
  readonly region?: 'world' | 'china';
}

export type TurnstileWidget = BaseResource<
  'TurnstileWidget',
  'cloudflare.k1c.io/v1alpha1',
  TurnstileWidgetSpec
>;

export interface SnippetSpec {
  readonly zoneId: string;
  /** Snippet name (zone-scoped key). Defaults to manifest `metadata.name`. */
  readonly snippetName?: string;
  /** Module file name registered in metadata.main_module. */
  readonly mainModule?: string;
  /** JavaScript source bytes for the snippet body. */
  readonly content: string;
}

export type Snippet = BaseResource<'Snippet', 'cloudflare.k1c.io/v1alpha1', SnippetSpec>;

export interface StreamKeySpec {
  /** Reserved; the Cloudflare side has no tunable fields for signing keys. */
  readonly placeholder?: never;
}

export type StreamKey = BaseResource<'StreamKey', 'cloudflare.k1c.io/v1alpha1', StreamKeySpec>;

export interface StreamWatermarkSpec {
  /** Display name on Cloudflare. Defaults to `k1c-<ns>-<name>`. */
  readonly profileName?: string;
  /** Path to the watermark image relative to the manifest cwd. */
  readonly filePath: string;
  readonly opacity?: number;
  readonly padding?: number;
  readonly position?: 'upperRight' | 'upperLeft' | 'lowerLeft' | 'lowerRight' | 'center';
  readonly scale?: number;
}

export type StreamWatermark = BaseResource<
  'StreamWatermark',
  'cloudflare.k1c.io/v1alpha1',
  StreamWatermarkSpec
>;

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
  | AIGateway
  | Hyperdrive
  | D1Database
  | Queue
  | Vectorize
  | DNSRecord
  | LogpushJob
  | TelemetryStack
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
  | ResponseHeaderRule
  | PageRule
  | StreamLiveInput
  | WorkerCronTrigger
  | R2BucketCors
  | R2BucketLifecycle
  | R2BucketEventNotification
  | R2CustomDomain
  | WorkerVersion
  | WorkerDeployment
  | TurnstileWidget
  | Snippet
  | StreamKey
  | StreamWatermark;

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
