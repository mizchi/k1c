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
  | LogpushJob;

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
