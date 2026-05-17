# Resource matrix

How Kubernetes resources map to Cloudflare in k1c. Three buckets: **v0** (must work for the first prototype), **later** (planned but not yet), **out of scope** (will not implement).

## v0 — minimum viable apply loop

Goal: a single Worker app with config, secrets, and persistent state can be applied and deleted end-to-end.

| Manifest kind | API group | Cloudflare resource | Provider | Notes |
|---|---|---|---|---|
| `Namespace` | `v1` | logical scope | (no provider) | Resource ownership label `k1c.io/namespace=<name>`. No Cloudflare object. |
| `Deployment` | `apps/v1` | Worker script(s) | `worker` | `replicas` ignored. `template.spec.containers[*].image` is each Worker's JS bundle. `cloudflare.com/source.<container>` can override the source path. Single-container Pods become one Worker; multi-container Pods become N Workers (primary unsuffixed, sidecars suffixed `--<container-name>`) with auto-wired `service` bindings between siblings — see "multi-container Pods" below. |
| `ConfigMap` | `v1` | Worker `[vars]` (plain bindings) | `configmap` | Mount style: env-var only. `data` keys become `vars` on the binding worker. |
| `Secret` | `v1` | Worker secret | `secret` | `stringData`/`data` (base64) decoded and uploaded via `PUT /accounts/.../workers/scripts/.../secrets`. Sensitive at rest in CF only. |
| `R2Bucket` (CRD) | `cloudflare.k1c.io/v1alpha1` | R2 bucket | `r2-bucket` | Bound to a Worker via `volumes[].csi.driver: r2.k1c.io` and `volumeAttributes.bucketRef`. |
| `KVNamespace` (CRD) | `cloudflare.k1c.io/v1alpha1` | KV namespace | `kv-namespace` | Bound via `volumes[].csi.driver: kv.k1c.io` and `volumeAttributes.namespaceRef`. |
| `DispatchNamespace` (CRD) | `cloudflare.k1c.io/v1alpha1` | Workers for Platforms dispatch namespace | `dispatch-namespace` | Bound to a dispatcher Worker via `volumes[].csi.driver: dispatch-namespace.k1c.io` and `volumeAttributes.ref`. |
| `AIGateway` (CRD) | `cloudflare.k1c.io/v1alpha1` | Cloudflare AI Gateway | `ai-gateway` | Creates an account-scoped AI Gateway. Workers use it through `env.AI.run(..., { gateway: { id } })`; `cloudflare.com/ai-gateway-ref` exposes the managed gateway id as an env var. |

### Multi-container Pods (v0.1.6)

A Pod with N containers lowers to N Workers, all top-level. The first container is the primary front-door and keeps the unsuffixed script name; subsequent containers are sidecars.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: gateway, image: ./dist/gateway.js }   # → k1c--default--api
        - { name: sidecar, image: ./dist/sidecar.js }   # → k1c--default--api--sidecar
```

| Container | Worker script name | Public reachable | Service bindings |
|---|---|---|---|
| `containers[0]` (primary) | `k1c--<ns>--<name>` | yes (Custom Domain etc.) | `env.<sibling-name>` for each other container |
| `containers[i]` (i > 0) | `k1c--<ns>--<name>--<container-name>` | no — sidecar | same |

Inside a Worker, the sibling is reached as `env.<container-name>.fetch(req)`. Container names follow Kubernetes DNS rules; if the name has a hyphen (e.g. `my-sidecar`), use `env['my-sidecar']`.

**Limitations**:
- ConfigMap / Secret / volume bindings are per-container (each container's `env` and `volumeMounts` resolve independently).
- Pod-level annotations (compatibility-date, observability, smart-placement) apply to every container in the Pod.
- `Rollout` with `cloudflare.com/dispatch-namespace` annotation (canary path) currently rejects multi-container manifests; per-container canary lifecycles are deferred.

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
              mountPath: /mnt/cache
            - name: media
              mountPath: /mnt/media
      volumes:
        - name: cache
          csi:
            driver: kv.k1c.io
            volumeAttributes:
              namespaceRef: cache-kv    # references KVNamespace.metadata.name
              binding: IMAGE_CACHE      # optional explicit env binding
        - name: media
          csi:
            driver: r2.k1c.io
            volumeAttributes:
              bucketRef: media-bucket
```

The Worker binding name is resolved as `volumeAttributes.binding`, then legacy
`volumeAttributes.bindingName`, then an upper-snake derivation from the volume
name (`media-assets` -> `MEDIA_ASSETS`). `mountPath` is not repurposed; it
remains a normal Kubernetes mount path for schema compatibility. The reconciler
resolves refs to the resource's NativeID before uploading the Worker.

CSI drivers currently supported: `r2.k1c.io`, `kv.k1c.io`, `d1.k1c.io`,
`hyperdrive.k1c.io`, `queue.k1c.io`, `vectorize.k1c.io`, `service.k1c.io`,
`dispatch-namespace.k1c.io`, `analytics-engine.k1c.io`, `mtls.k1c.io`, and
`pipelines.k1c.io`.

### Dynamic Workers and Workers for Platforms bindings

Dynamic Workers are enabled with the Worker Loader binding. Add
`cloudflare.com/worker-loader: enabled` to a `Deployment` or `Rollout` to emit
`{ type: "worker_loader", name: "LOADER" }`; set the annotation to another
string to choose a different binding name.

Workers for Platforms dispatch namespace bindings can be attached to regular
`Deployment` / `Rollout` Workers with a CSI volume:

```yaml
volumes:
  - name: users
    csi:
      driver: dispatch-namespace.k1c.io
      volumeAttributes:
        ref: production
        binding: DISPATCHER
        remote: "true"
```

`ref` (or legacy `namespaceRef`) resolves a `DispatchNamespace` in the same
namespace. `remote` is a Wrangler local-development hint and is emitted only by
`k1c wrangler-config`; the Cloudflare Worker upload metadata stores the binding
as `dispatch_namespace` without that local-only flag.

### Workers AI, AI Gateway, and Cloudflare Agents

Workers AI is enabled with `cloudflare.com/ai`. Value `enabled` uses binding
`AI`; any other value is used as the binding name. AI Gateway does not add a
separate Worker binding; it is selected at call time through the Workers AI
binding:

```js
await env.AI.run(model, input, { gateway: { id: env.AI_GATEWAY_ID } });
```

Create a managed gateway with `kind: AIGateway`, then add
`cloudflare.com/ai-gateway-ref: <metadata.name>` on a `Deployment` / `Rollout`.
k1c sets `AI_GATEWAY_ID` (or the name from `cloudflare.com/ai-gateway-var`) to
the Cloudflare gateway id and adds a dependency on the `AIGateway` resource.
Use `cloudflare.com/ai-gateway-id: default` when you want Cloudflare's
auto-created default gateway instead of a k1c-managed gateway.

Cloudflare Agents are Durable Objects. Add
`cloudflare.com/agent-classes: ChatAgent, ToolAgent` to a Worker-backed
manifest to emit:

- `durable_objects.bindings` for each class
- a SQLite `migrations.new_sqlite_classes` entry
- the required `nodejs_compat` compatibility flag

This handles the platform wiring. The Worker code still needs to export the
matching Agent classes and be bundled if it imports the `agents` npm package.

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
| `cloudflare.com/source.<container>` | `Deployment`, `Rollout` | Worker entrypoint path override for the named container. |
| `cloudflare.com/ai` | `Deployment`, `Rollout` | Adds a Workers AI binding. Value `enabled` uses `AI`; any other value is the binding name. |
| `cloudflare.com/ai-gateway-ref` | `Deployment`, `Rollout` | Resolves an `AIGateway` in the same namespace, adds an AI binding if needed, sets `AI_GATEWAY_ID`, and depends on that gateway. |
| `cloudflare.com/ai-gateway-id` | `Deployment`, `Rollout` | Literal AI Gateway id, e.g. `default`. Mutually exclusive with `cloudflare.com/ai-gateway-ref`. |
| `cloudflare.com/ai-gateway-var` | `Deployment`, `Rollout` | Env var name for the gateway id. Default `AI_GATEWAY_ID`. |
| `cloudflare.com/agent-classes` | `Deployment`, `Rollout` | Comma-separated Cloudflare Agents / Durable Object class names. Adds DO bindings, SQLite migrations, and `nodejs_compat`. |
| `cloudflare.com/images` | `Deployment`, `Rollout` | Adds a Cloudflare Images binding. Value `enabled` uses `IMAGES`; any other value is the binding name. |
| `cloudflare.com/worker-loader` | `Deployment`, `Rollout` | Adds a Dynamic Workers Worker Loader binding. Value `enabled` uses `LOADER`; any other value is the binding name. |
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
