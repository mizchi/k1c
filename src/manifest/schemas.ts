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

export const k1cResourceSchema = z.discriminatedUnion('kind', [
  deploymentSchema,
  rolloutSchema,
  configMapSchema,
  secretSchema,
  namespaceSchema,
  serviceSchema,
  r2BucketSchema,
  kvNamespaceSchema,
  dispatchNamespaceSchema,
]);
