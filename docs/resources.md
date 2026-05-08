# Resource matrix

How Kubernetes resources map to Cloudflare in k1c. Three buckets: **v0** (must work for the first prototype), **later** (planned but not yet), **out of scope** (will not implement).

## v0 — minimum viable apply loop

Goal: a single Worker app with config, secrets, and persistent state can be applied and deleted end-to-end.

| Manifest kind | API group | Cloudflare resource | Provider | Notes |
|---|---|---|---|---|
| `Namespace` | `v1` | logical scope | (no provider) | Resource ownership label `k1c.io/namespace=<name>`. No Cloudflare object. |
| `Deployment` | `apps/v1` | Worker script | `worker` | `replicas` ignored; `template.spec.containers[0].image` parsed for the JS bundle reference. Single-container only in v0. |
| `ConfigMap` | `v1` | Worker `[vars]` (plain bindings) | `configmap` | Mount style: env-var only. `data` keys become `vars` on the binding worker. |
| `Secret` | `v1` | Worker secret | `secret` | `stringData`/`data` (base64) decoded and uploaded via `PUT /accounts/.../workers/scripts/.../secrets`. Sensitive at rest in CF only. |
| `R2Bucket` (CRD) | `cloudflare.k1c.io/v1alpha1` | R2 bucket | `r2-bucket` | Bound to a Worker via `Deployment.spec.template.spec.volumes[].r2BucketRef`. |
| `KVNamespace` (CRD) | `cloudflare.k1c.io/v1alpha1` | KV namespace | `kv-namespace` | Bound via `volumes[].kvNamespaceRef`. |

### v0 binding model

Bindings between Workers and storage are expressed by a small extension to PodSpec.volumes:

```yaml
spec:
  template:
    spec:
      containers:
        - name: app
          image: ./dist/worker.js
          volumeMounts:
            - name: cache
              mountPath: KV_CACHE       # becomes binding name
            - name: media
              mountPath: R2_MEDIA
      volumes:
        - name: cache
          kvNamespaceRef:
            name: cache-kv              # references KVNamespace.metadata.name
        - name: media
          r2BucketRef:
            name: media-bucket
```

`mountPath` is repurposed as the **binding identifier** the Worker code sees on `env`. The reconciler resolves `*Ref` to the resource's NativeID before uploading the Worker.

### v0 deletion behavior

`apply` with a manifest that no longer contains a previously-managed resource → the resource is deleted, **except** R2 buckets and KV namespaces, which require `--cascade=true` to drop. R2 data is treated as user data; default-deleting it on a typo would be unsafe.

## Later — added in subsequent milestones

| Milestone | Manifest kind | API group | Cloudflare resource | Notes |
|---|---|---|---|---|
| v0.1 | `Service` | `v1` | Service Binding (intra-account) / Custom Domain (external) | `type: ClusterIP` → Service Binding. `type: LoadBalancer` → Custom Domain (requires `cloudflare.com/zone-id` annotation). |
| v0.1.1 | `Rollout` | `argoproj.io/v1alpha1` | Worker Versions + Gradual Deployments | Schema: `strategy.blueGreen.{autoPromotionEnabled, scaleDownDelaySeconds}` and `strategy.canary.steps[]` with `setWeight` / `pause`. `trafficRouting` ignored. **v0.1.1 implemented**: Worker provider uploads via `scripts.versions.create` and routes via `scripts.deployments.create` (cutover at 100% to the new version). This is the correct path for `blueGreen.autoPromotionEnabled=true` (default). Provides instant rollback via prior version ids. **Deferred to v0.1.2**: `canary.steps` (state machine across applies, traffic-split), `blueGreen.autoPromotionEnabled=false` (manual promote command). Lowering emits a warning for those cases and falls back to cutover. |
| v0.2 | `CronJob` | `batch/v1` | Cron Trigger | `spec.schedule` mapped 1:1; `jobTemplate.spec.template.spec.containers[0].image` is the Worker entrypoint. |
| v0.2 | `CustomHostname` (CRD) | `cloudflare.k1c.io/v1alpha1` | Custom Hostname (SaaS routing) | Async via `status` polling for SSL provisioning. |
| v0.3 | `DurableObjectClass` (CRD) | `cloudflare.k1c.io/v1alpha1` | DO class binding + migrations | Migration table maintained in object metadata. |
| v0.3 | `Queue` (CRD) | `cloudflare.k1c.io/v1alpha1` | Queues (producer + consumer wiring) | Consumer is a Worker reference. |
| v0.4 | `Ingress` | `networking.k8s.io/v1` | Workers Routes (zone-scoped pattern) | Path-based fan-out compiled into a router Worker. |
| v0.4 | `PersistentVolumeClaim` + `StorageClass: r2` | `v1` | R2 bucket (re-binding) | Sugar over `R2Bucket`. POSIX semantics not promised. |
| v1.x | `D1Database` (CRD) | `cloudflare.k1c.io/v1alpha1` | D1 |  |
| v1.x | `Hyperdrive` (CRD) | `cloudflare.k1c.io/v1alpha1` | Hyperdrive |  |
| v1.x | `Vectorize` (CRD) | `cloudflare.k1c.io/v1alpha1` | Vectorize |  |
| v1.x | `Job` | `batch/v1` | Workflows | Single-shot batch via Workflows. |
| v1.x | `StatefulSet` | `apps/v1` | Ordinal DO instances | Each ordinal = stable DO id. Limited to a single replica set per Worker class. |

## Out of scope — will not implement

| Manifest kind | Reason |
|---|---|
| `DaemonSet` | Cloudflare's edge is implicitly global; per-node placement is not a user concept. Manifest containing `DaemonSet` is rejected with an explanatory error. |
| `HorizontalPodAutoscaler` | Workers auto-scale by default. Accepted in manifests but no-op with a warning. |
| `Pod` (bare) | Lifecycle without owner reference is anti-pattern; require `Deployment`. Bare `Pod` is rejected. |
| `NetworkPolicy` | Cloudflare Service Bindings express allow-list; no general egress firewall in our scope. Use WAF or Service Bindings instead. |
| `PodDisruptionBudget` | No node-level disruption concept on Workers. Accepted but no-op. |
| `Endpoints` / `EndpointSlice` | Implementation detail of `Service` on Kubernetes. We bind directly. |
| `LimitRange`, `ResourceQuota` | Cloudflare imposes account-level limits, not in-cluster quotas. |
| `kubectl exec`, `kubectl logs -f`, `port-forward` | Belong to a control plane (ADR-0002). Use `wrangler tail` directly for now. |

## Annotations recognised in v0

All optional unless marked.

| Annotation | Applies to | Purpose |
|---|---|---|
| `cloudflare.com/account-id` | any | Override default account from `K1C_ACCOUNT_ID` env. |
| `cloudflare.com/zone-id` | `Service` (LoadBalancer), `Ingress`, `CustomHostname` | Zone for routing/DNS. **Required** when external. |
| `cloudflare.com/compatibility-date` | `Deployment`, `Rollout`, `CronJob` | Worker compatibility date. Default `2025-01-01`. |
| `cloudflare.com/compatibility-flags` | as above | Comma-separated. |
| `cloudflare.com/observability` | `Deployment`, `Rollout` | `enabled` / `disabled`. |
| `cloudflare.com/smart-placement` | `Deployment`, `Rollout` | `smart` / `default`. |
| `cloudflare.com/limits-cpu-ms` | `Deployment`, `Rollout` | Worker CPU time limit. |
| `k1c.io/managed-by` | (set by k1c, not user) | Always `k1c` on resources we own. |
| `k1c.io/last-applied` | (set by k1c) | Hash of last applied manifest for diff. |

## Ownership scheme

For each Cloudflare resource type, k1c identifies its own resources by:

| Resource | Marker |
|---|---|
| Worker script | name prefix `k1c--<namespace>--<name>` + script `metadata.tags` includes `k1c.io/managed-by=k1c` |
| R2 bucket | name prefix `k1c-<namespace>-<name>` |
| KV namespace | title prefix `k1c/<namespace>/<name>` |
| DNS record | `comment` field contains `k1c.io/managed-by=k1c,namespace=<ns>,name=<name>` |
| Worker route | zone-scoped list, pattern matched against managed Workers |
| Custom Hostname | metadata `custom_metadata` includes our markers |
| Cron Trigger | scoped to a managed Worker, no extra marker |

The reconciler queries each resource type, filters by these markers, and computes diffs against the manifest. Resources without our markers are treated as foreign and never modified.
