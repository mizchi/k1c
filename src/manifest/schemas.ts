import { z } from 'zod';

const objectMetaSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
});

const envVarSourceSchema = z.object({
  configMapKeyRef: z
    .object({ name: z.string(), key: z.string() })
    .optional(),
  secretKeyRef: z
    .object({ name: z.string(), key: z.string() })
    .optional(),
});

const envVarSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  valueFrom: envVarSourceSchema.optional(),
});

const volumeMountSchema = z.object({
  name: z.string(),
  mountPath: z.string(),
});

const volumeSchema = z.object({
  name: z.string(),
  r2BucketRef: z.object({ name: z.string() }).optional(),
  kvNamespaceRef: z.object({ name: z.string() }).optional(),
  serviceRef: z.object({ name: z.string() }).optional(),
  hyperdriveRef: z.object({ name: z.string() }).optional(),
  d1DatabaseRef: z.object({ name: z.string() }).optional(),
  queueRef: z.object({ name: z.string() }).optional(),
  vectorizeRef: z.object({ name: z.string() }).optional(),
  analyticsEngineRef: z.object({ dataset: z.string() }).optional(),
  mtlsCertificateRef: z.object({ certificateId: z.string() }).optional(),
  pipelinesRef: z.object({ pipelineId: z.string() }).optional(),
});

const containerSchema = z.object({
  name: z.string(),
  image: z.string(),
  env: z.array(envVarSchema).optional(),
  volumeMounts: z.array(volumeMountSchema).optional(),
});

const podSpecSchema = z.object({
  containers: z.array(containerSchema).min(1),
  volumes: z.array(volumeSchema).optional(),
});

const podTemplateSpecSchema = z.object({
  metadata: objectMetaSchema.partial({ name: true }).optional(),
  spec: podSpecSchema,
});

const deploymentSpecSchema = z.object({
  replicas: z.number().int().nonnegative().optional(),
  selector: z.object({ matchLabels: z.record(z.string()) }),
  template: podTemplateSpecSchema,
});

export const deploymentSchema = z.object({
  apiVersion: z.literal('apps/v1'),
  kind: z.literal('Deployment'),
  metadata: objectMetaSchema,
  spec: deploymentSpecSchema,
});

const statefulSetSpecSchema = z.object({
  replicas: z.number().int().nonnegative().optional(),
  serviceName: z.string().optional(),
  selector: z.object({ matchLabels: z.record(z.string()) }),
  template: podTemplateSpecSchema,
});

export const statefulSetSchema = z.object({
  apiVersion: z.literal('apps/v1'),
  kind: z.literal('StatefulSet'),
  metadata: objectMetaSchema,
  spec: statefulSetSpecSchema,
});

const blueGreenSchema = z.object({
  autoPromotionEnabled: z.boolean().optional(),
  scaleDownDelaySeconds: z.number().int().nonnegative().optional(),
});

const canaryStepSchema = z.union([
  z.object({ setWeight: z.number().min(0).max(100) }),
  z.object({ pause: z.object({ duration: z.string().optional() }) }),
]);

const canarySchema = z.object({
  steps: z.array(canaryStepSchema),
});

const rolloutStrategySchema = z.union([
  z.object({ blueGreen: blueGreenSchema }),
  z.object({ canary: canarySchema }),
]);

const rolloutSpecSchema = z.object({
  replicas: z.number().int().nonnegative().optional(),
  selector: z.object({ matchLabels: z.record(z.string()) }),
  template: podTemplateSpecSchema,
  strategy: rolloutStrategySchema,
});

export const rolloutSchema = z.object({
  apiVersion: z.literal('argoproj.io/v1alpha1'),
  kind: z.literal('Rollout'),
  metadata: objectMetaSchema,
  spec: rolloutSpecSchema,
});

const cronJobSpecSchema = z.object({
  schedule: z.string().min(1),
  jobTemplate: z.object({
    spec: z.object({ template: podTemplateSpecSchema }),
  }),
  successfulJobsHistoryLimit: z.number().int().nonnegative().optional(),
  failedJobsHistoryLimit: z.number().int().nonnegative().optional(),
  suspend: z.boolean().optional(),
});

export const cronJobSchema = z.object({
  apiVersion: z.literal('batch/v1'),
  kind: z.literal('CronJob'),
  metadata: objectMetaSchema,
  spec: cronJobSpecSchema,
});

export const configMapSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('ConfigMap'),
  metadata: objectMetaSchema,
  data: z.record(z.string()).optional(),
});

export const secretSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('Secret'),
  metadata: objectMetaSchema,
  type: z.string().optional(),
  data: z.record(z.string()).optional(),
  stringData: z.record(z.string()).optional(),
});

export const namespaceSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('Namespace'),
  metadata: objectMetaSchema,
});

export const serviceSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('Service'),
  metadata: objectMetaSchema,
  spec: z.object({
    type: z.enum(['ClusterIP', 'LoadBalancer']).optional(),
    selector: z.record(z.string()),
    ports: z
      .array(
        z.object({
          port: z.number().int().positive(),
          targetPort: z.number().int().positive().optional(),
          name: z.string().optional(),
          protocol: z.enum(['TCP', 'UDP']).optional(),
        }),
      )
      .optional(),
  }),
});

export const r2BucketSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('R2Bucket'),
  metadata: objectMetaSchema,
  spec: z.object({
    location: z.enum(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']).optional(),
    storageClass: z.enum(['Standard', 'InfrequentAccess']).optional(),
  }),
});

export const kvNamespaceSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('KVNamespace'),
  metadata: objectMetaSchema,
  spec: z.object({
    title: z.string().optional(),
  }),
});

export const dispatchNamespaceSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('DispatchNamespace'),
  metadata: objectMetaSchema,
  spec: z.object({}).strict().optional().default({}),
});

export const hyperdriveSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('Hyperdrive'),
  metadata: objectMetaSchema,
  spec: z.object({
    origin: z.object({
      scheme: z.enum(['postgres', 'postgresql', 'mysql']),
      host: z.string().min(1),
      port: z.number().int().positive(),
      database: z.string().min(1),
      user: z.string().min(1),
      passwordSecretRef: z.object({ name: z.string(), key: z.string() }),
    }),
    caching: z
      .object({
        disabled: z.boolean().optional(),
        maxAge: z.number().int().nonnegative().optional(),
        staleWhileRevalidate: z.number().int().nonnegative().optional(),
      })
      .optional(),
    originConnectionLimit: z.number().int().positive().optional(),
  }),
});

export const d1DatabaseSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('D1Database'),
  metadata: objectMetaSchema,
  spec: z
    .object({
      primaryLocationHint: z
        .enum(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'])
        .optional(),
    })
    .optional()
    .default({}),
});

export const queueSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('Queue'),
  metadata: objectMetaSchema,
  spec: z
    .object({
      consumer: z.object({ workerName: z.string() }).optional(),
    })
    .optional()
    .default({}),
});

export const vectorizeSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('Vectorize'),
  metadata: objectMetaSchema,
  spec: z.object({
    dimensions: z.number().int().positive(),
    metric: z.enum(['cosine', 'euclidean', 'dot-product']),
    description: z.string().optional(),
  }),
});

export const dnsRecordSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('DNSRecord'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string(),
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']),
    name: z.string(),
    content: z.string(),
    ttl: z.number().int().nonnegative().optional(),
    proxied: z.boolean().optional(),
    priority: z.number().int().nonnegative().optional(),
  }),
});

const jobSpecSchema = z.object({
  template: podTemplateSpecSchema,
  backoffLimit: z.number().int().nonnegative().optional(),
  activeDeadlineSeconds: z.number().int().positive().optional(),
  completions: z.number().int().positive().optional(),
  parallelism: z.number().int().positive().optional(),
});

export const jobSchema = z.object({
  apiVersion: z.literal('batch/v1'),
  kind: z.literal('Job'),
  metadata: objectMetaSchema,
  spec: jobSpecSchema,
});

export const logpushJobSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('LogpushJob'),
  metadata: objectMetaSchema,
  spec: z
    .object({
      zoneId: z.string().optional(),
      accountId: z.string().optional(),
      dataset: z.enum([
        'http_requests',
        'workers_trace_events',
        'firewall_events',
        'access_requests',
        'audit_logs',
        'dns_logs',
        'spectrum_events',
        'nel_reports',
        'gateway_dns',
        'gateway_http',
        'gateway_network',
        'magic_ids_detections',
        'network_analytics_logs',
      ]),
      destinationConf: z.string().min(1),
      enabled: z.boolean().optional(),
      filter: z.string().optional(),
    })
    .refine((s) => (s.zoneId !== undefined) !== (s.accountId !== undefined), {
      message: 'LogpushJob.spec must specify exactly one of zoneId / accountId',
    }),
});

const ingressBackendSchema = z.object({
  service: z.object({
    name: z.string().min(1),
    port: z
      .object({
        number: z.number().int().positive().optional(),
        name: z.string().optional(),
      })
      .optional(),
  }),
});

const ingressPathSchema = z.object({
  path: z.string().min(1),
  pathType: z.enum(['Prefix', 'Exact', 'ImplementationSpecific']),
  backend: ingressBackendSchema,
});

const ingressRuleSchema = z.object({
  host: z.string().min(1).optional(),
  http: z.object({ paths: z.array(ingressPathSchema).min(1) }),
});

const accessRuleSchema = z.union([
  z.object({ email: z.object({ email: z.string().min(1) }) }),
  z.object({ emailDomain: z.object({ domain: z.string().min(1) }) }),
  z.object({ everyone: z.object({}).strict() }),
  z.object({ ip: z.object({ ip: z.string().min(1) }) }),
  z.object({ country: z.object({ code: z.string().min(2) }) }),
  z.object({ serviceToken: z.object({ tokenId: z.string().min(1) }) }),
  z.object({ anyValidServiceToken: z.object({}).strict() }),
]);

const accessAppPolicySchema = z.object({
  name: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'bypass', 'non_identity']),
  include: z.array(accessRuleSchema).min(1),
  exclude: z.array(accessRuleSchema).optional(),
  require: z.array(accessRuleSchema).optional(),
  sessionDuration: z.string().optional(),
});

const accessPolicyRefSchema = z.object({ ref: z.string().min(1) }).strict();

const accessApplicationPolicyItemSchema = z.union([
  accessPolicyRefSchema,
  accessAppPolicySchema,
]);

export const accessPolicySchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('AccessPolicy'),
  metadata: objectMetaSchema,
  spec: z.object({
    decision: z.enum(['allow', 'deny', 'bypass', 'non_identity']),
    include: z.array(accessRuleSchema).min(1),
    exclude: z.array(accessRuleSchema).optional(),
    require: z.array(accessRuleSchema).optional(),
    sessionDuration: z.string().optional(),
  }),
});

const cacheRuleTtlSchema = z.object({
  mode: z.enum(['respect_origin', 'bypass_by_default', 'override_origin']),
  default: z.number().int().nonnegative().optional(),
});

export const cacheRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('CacheRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    expression: z.string().min(1),
    cache: z.boolean(),
    enabled: z.boolean().optional(),
    edgeTtl: cacheRuleTtlSchema.optional(),
    browserTtl: cacheRuleTtlSchema.optional(),
    description: z.string().optional(),
  }),
});

const transformHeaderActionSchema = z.object({
  operation: z.enum(['set', 'add', 'remove']),
  value: z.string().optional(),
});

export const transformRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('TransformRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    expression: z.string().min(1),
    enabled: z.boolean().optional(),
    headers: z.record(transformHeaderActionSchema),
    description: z.string().optional(),
  }),
});

export const wafCustomRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('WAFCustomRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    expression: z.string().min(1),
    action: z.enum(['block', 'challenge', 'managed_challenge', 'js_challenge', 'log', 'skip']),
    enabled: z.boolean().optional(),
    description: z.string().optional(),
  }),
});

const ratelimitConfigSpecSchema = z.object({
  characteristics: z.array(z.string()).min(1),
  period: z.number().int().positive(),
  requestsPerPeriod: z.number().int().positive(),
  mitigationTimeout: z.number().int().nonnegative().optional(),
  countingExpression: z.string().optional(),
  requestsToOrigin: z.boolean().optional(),
});

const emailRoutingMatcherSchema = z.union([
  z.object({ type: z.literal('all') }).strict(),
  z.object({
    type: z.literal('literal'),
    field: z.literal('to'),
    value: z.string().min(1),
  }).strict(),
]);

const emailRoutingActionSchema = z.union([
  z.object({ type: z.literal('drop') }).strict(),
  z.object({ type: z.literal('forward'), to: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal('worker'), worker: z.string().min(1) }).strict(),
]);

const uriPartSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ expression: z.string() }).strict(),
]);

export const uriRewriteRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('URIRewriteRule'),
  metadata: objectMetaSchema,
  spec: z
    .object({
      zoneId: z.string().min(1),
      expression: z.string().min(1),
      enabled: z.boolean().optional(),
      path: uriPartSchema.optional(),
      query: uriPartSchema.optional(),
      description: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.path === undefined && data.query === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['path'],
          message: 'URIRewriteRule must specify at least one of spec.path or spec.query',
        });
      }
    }),
});

export const responseHeaderRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('ResponseHeaderRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    expression: z.string().min(1),
    enabled: z.boolean().optional(),
    headers: z.record(transformHeaderActionSchema),
    description: z.string().optional(),
  }),
});

export const emailRoutingRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('EmailRoutingRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    ruleName: z.string().min(1),
    enabled: z.boolean().optional(),
    priority: z.number().int().nonnegative().optional(),
    matchers: z.array(emailRoutingMatcherSchema).min(1),
    actions: z.array(emailRoutingActionSchema).min(1),
  }),
});

export const wafManagedRulesetSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('WAFManagedRuleset'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    rulesetId: z.string().min(1),
    enabled: z.boolean().optional(),
    expression: z.string().optional(),
    overrideAction: z.enum(['block', 'challenge', 'managed_challenge', 'js_challenge', 'log']).optional(),
    description: z.string().optional(),
  }),
});

export const customHostnameSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('CustomHostname'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    hostname: z.string().min(1),
    ssl: z
      .object({
        method: z.enum(['http', 'cname', 'txt', 'email']).optional(),
        type: z.literal('dv').optional(),
      })
      .optional(),
  }),
});

export const rateLimitRuleSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('RateLimitRule'),
  metadata: objectMetaSchema,
  spec: z.object({
    zoneId: z.string().min(1),
    expression: z.string().min(1),
    action: z.enum(['block', 'managed_challenge', 'js_challenge', 'log']),
    enabled: z.boolean().optional(),
    ratelimit: ratelimitConfigSpecSchema,
    description: z.string().optional(),
  }),
});

const accessApplicationSpecSchema = z
  .object({
    domain: z.string().min(1),
    type: z
      .enum(['self_hosted', 'ssh', 'vnc', 'biso', 'saas', 'infrastructure', 'bookmark'])
      .optional(),
    sessionDuration: z.string().optional(),
    autoRedirectToIdentity: z.boolean().optional(),
    allowedIdps: z.array(z.string()).optional(),
    policies: z.array(accessApplicationPolicyItemSchema).optional(),
    logoUrl: z.string().url().optional(),
    appLauncherVisible: z.boolean().optional(),
    saasApp: z.record(z.unknown()).optional(),
    targetCriteria: z.array(z.record(z.unknown())).optional(),
  })
  .superRefine((data, ctx) => {
    const t = data.type ?? 'self_hosted';
    const policyCount = data.policies?.length ?? 0;
    if (t === 'bookmark') {
      if (policyCount > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies'],
          message: 'bookmark AccessApplications cannot carry policies',
        });
      }
    } else if (policyCount < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies'],
        message: `${t} AccessApplication requires at least one entry in spec.policies`,
      });
    }
    if (t !== 'bookmark' && data.logoUrl !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['logoUrl'],
        message: 'logoUrl only applies to bookmark AccessApplications',
      });
    }
    if (t !== 'saas' && data.saasApp !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['saasApp'],
        message: 'saasApp only applies to type=saas AccessApplications',
      });
    }
    if (t === 'saas' && data.saasApp === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['saasApp'],
        message: 'type=saas AccessApplications require spec.saasApp',
      });
    }
    if (t !== 'infrastructure' && data.targetCriteria !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetCriteria'],
        message: 'targetCriteria only applies to type=infrastructure AccessApplications',
      });
    }
    if (t === 'infrastructure' && (data.targetCriteria === undefined || data.targetCriteria.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetCriteria'],
        message: 'type=infrastructure AccessApplications require at least one targetCriteria entry',
      });
    }
  });

export const accessApplicationSchema = z.object({
  apiVersion: z.literal('cloudflare.k1c.io/v1alpha1'),
  kind: z.literal('AccessApplication'),
  metadata: objectMetaSchema,
  spec: accessApplicationSpecSchema,
});

export const ingressSchema = z.object({
  apiVersion: z.literal('networking.k8s.io/v1'),
  kind: z.literal('Ingress'),
  metadata: objectMetaSchema,
  spec: z.object({
    rules: z.array(ingressRuleSchema).min(1),
    defaultBackend: ingressBackendSchema.optional(),
  }),
});

export const k1cResourceSchema = z.discriminatedUnion('kind', [
  deploymentSchema,
  rolloutSchema,
  statefulSetSchema,
  cronJobSchema,
  jobSchema,
  configMapSchema,
  secretSchema,
  namespaceSchema,
  serviceSchema,
  r2BucketSchema,
  kvNamespaceSchema,
  dispatchNamespaceSchema,
  hyperdriveSchema,
  d1DatabaseSchema,
  queueSchema,
  vectorizeSchema,
  dnsRecordSchema,
  logpushJobSchema,
  ingressSchema,
  accessApplicationSchema,
  accessPolicySchema,
  cacheRuleSchema,
  transformRuleSchema,
  wafCustomRuleSchema,
  rateLimitRuleSchema,
  customHostnameSchema,
  wafManagedRulesetSchema,
  emailRoutingRuleSchema,
  uriRewriteRuleSchema,
  responseHeaderRuleSchema,
]);
