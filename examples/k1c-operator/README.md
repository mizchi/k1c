# k1c operator

Runs `k1c apply` continuously inside a real Kubernetes cluster. Watches
both the Cloudflare CRDs (`cloudflare.k1c.io/v1alpha1` group) and any
standard k8s resource carrying the label `k1c.io/managed=true`, then
forwards changes to Cloudflare via the same lower / plan / apply core
the CLI uses.

## Image format

The image is published to GHCR as an **OCI v1.1 multi-arch image**
(`linux/amd64` + `linux/arm64`) on every release-please tag.

  ghcr.io/mizchi/k1c-operator:latest
  ghcr.io/mizchi/k1c-operator:0.9.0
  ghcr.io/mizchi/k1c-operator:v0.9.0

OCI annotations carry source / revision / version, plus the
`docker/build-push-action` SLSA provenance + SBOM attestations are
attached so consumers can verify the image came from this workflow run.

The CLI bundle (`pnpm build:wasm`) compiles to a WASI 0.2 component
via `componentize-js` — see the project README. The operator itself
still runs only as a Node container because `@kubernetes/client-node`
uses HTTP/2 + raw streams that wasi-http preview-2 doesn't expose
yet; the CLI ships first because it only needs `fetch`.

## Architecture

```
   GitOps tool (Argo CD / Flux)
      │ kubectl apply
      ▼
  ┌────────────┐    watch       ┌──────────────┐
  │   etcd     │ ───────────►   │ k1c operator │ ───── Cloudflare API
  │ (CRDs +    │                │  (this Pod)  │
  │  Pod / etc)│                └──────────────┘
  └────────────┘
```

The operator is a thin facade — every reconcile pass:

  1. Lists Cloudflare CRD instances + label-matched standard kinds via
     the k8s API.
  2. **Phase A — cleanup**: for every CR with `deletionTimestamp` and
     our `k1c.io/cleanup` finalizer, look up the persisted
     `status.cloudflareNativeId`, call `provider.delete`, then strip
     the finalizer. k8s GCs the CR once all finalizers are gone.
  3. **Phase B — apply**: ensures every alive CR carries the
     `k1c.io/cleanup` finalizer (so `kubectl delete` will trigger
     Phase A on the next pass), then feeds them through the same
     `parseManifest → lower → plan → apply` pipeline `k1c apply -f`
     uses.
  4. Reports per-op status on stdout.
  5. Patches `.status.conditions` on every touched Cloudflare CRD so
     `kubectl get r2bucket` (etc.) reflects `Reconciled` /
     `ReconcileFailed` plus the underlying error message, and
     persists the Cloudflare native id at
     `.status.cloudflareNativeId` for the cleanup path.

So the operator and the CLI share 99% of the implementation. A change to
the lower / plan / apply core ships to both at once.

### Cascade delete

```sh
$ kubectl apply -f - <<EOF
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: { location: weur }
EOF
$ kubectl get r2bucket media -o jsonpath='{.metadata.finalizers}'
["k1c.io/cleanup"]
$ kubectl get r2bucket media -o jsonpath='{.status.cloudflareNativeId}'
k1c-default-media

$ kubectl delete r2bucket media
# 5s later:
$ kubectl get r2bucket media
Error from server (NotFound): r2buckets ... "media" not found
$ k1c get R2Bucket
(no R2Bucket resources found)   # bucket gone from CF too — no orphan
```

If `provider.delete` fails (network blip, permission tweak), the
finalizer stays put and the cleanup retries on the next tick. The CR
sticks around (with a `deletionTimestamp`) until the operator
acknowledges, so `kubectl get` will keep showing it.

### Reconcile triggers

By default the operator opens k8s **watch streams** on every Cloudflare
CRD plural and every label-gated standard kind, debounces events by
500ms, and triggers a reconcile pass on each burst. The `--interval`
flag (default 30s) doubles as a resync safety net to catch any events
the apiserver might drop during a watch reconnect. Pass `--no-watch`
to fall back to pure interval-driven polling — useful for clusters
that don't permit long-lived watch connections.

### Status conditions

```sh
$ kubectl get r2bucket -A
NAMESPACE   NAME    AGE
default     media   3m

$ kubectl get r2bucket media -o jsonpath='{.status.conditions}' | jq
[
  {
    "type": "Ready",
    "status": "True",
    "reason": "Reconciled",
    "message": "1 ok / 0 failed / 0 skipped",
    "lastTransitionTime": "2026-05-09T15:42:01.123Z"
  }
]
```

A `Ready=False` / `reason=ReconcileFailed` condition includes the
underlying provider error in `message` (e.g. `[NotFound] 404 ...`).

### Metrics + dashboard

The operator exposes `/metrics` (Prometheus 0.0.4 text format),
`/healthz`, and `/readyz` on port 9090. The helm chart can emit a
`monitoring.coreos.com/v1 ServiceMonitor` for kube-prometheus
auto-discovery — set `serviceMonitor.enabled=true`. A starter
Grafana dashboard sits at
[`grafana-dashboard.json`](grafana-dashboard.json) — import via
`Grafana → Dashboards → Import`. Panels:

  * Up / Leader / Managed-resource counts
  * Reconcile pass outcome (1m rate, by `outcome`)
  * Per-op result (1m rate, by `result`)
  * Watch events (1m rate, by `kind`)
  * Reconcile duration (avg over 1m)
  * Finalizer ops (1m rate, by `outcome`)

The full metric set:

| metric | type | labels | what |
|---|---|---|---|
| `k1c_operator_up` | gauge | — | 1 while the operator process is alive |
| `k1c_operator_is_leader` | gauge | — | 1 on the leader, 0 on followers |
| `k1c_operator_managed_resources` | gauge | — | size of the last list pass |
| `k1c_operator_reconcile_passes_total` | counter | `outcome=ok\|partial\|noop\|error` | one increment per reconcile pass |
| `k1c_operator_reconcile_total` | counter | `result=ok\|failed\|skipped\|error` | per-op result |
| `k1c_operator_reconcile_duration_seconds` | summary | — | wall-clock per reconcile pass (count + sum) |
| `k1c_operator_watch_events_total` | counter | `kind`, `phase` | apiserver watch events delivered |
| `k1c_operator_finalizer_total` | counter | `outcome=attached\|deleted\|delete_failed\|orphan`, `kind` | finalizer cleanup outcomes |

## Install

```sh
# Register Cloudflare CRDs once
k1c export-crds | kubectl apply -f -

# API token Secret
kubectl create namespace k1c-system
kubectl -n k1c-system create secret generic cloudflare-api-token \
  --from-literal=K1C_ACCOUNT_ID=<your-account-id> \
  --from-literal=CLOUDFLARE_API_TOKEN=<your-token>

# Operator deployment + RBAC
kubectl apply -f install.yaml

# Verify
kubectl -n k1c-system logs -l app=k1c-operator -f
```

## Opt-in label

Standard k8s kinds (Deployment / Service / ConfigMap / Secret / Ingress
/ StatefulSet / CronJob / Job) are not picked up unless they carry
`k1c.io/managed=true`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    k1c.io/managed: "true"   # opt in
spec: {...}
```

Cloudflare CRDs (`R2Bucket`, `KVNamespace`, ...) are picked up
unconditionally — their mere presence in etcd implies the user wants
Cloudflare to host them.

## Configuration

Environment variables (set on the Deployment):

  K1C_ACCOUNT_ID         Cloudflare account id
  CLOUDFLARE_API_TOKEN   Cloudflare API token (broad Custom Token recommended)
  K1C_ZONE_ID            (optional) default zone id

Operators reconcile every Cloudflare CRD enabled in your cluster, so the token
needs the union of permissions across all kinds present in etcd. Use the
copy-paste permission list in [docs/api-token.md](../../docs/api-token.md) —
shrinking it after the fact (least-privilege) is documented in the same file.

Container args:

  operator run [-n <namespace>] [--interval 30] [--no-watch]

`-n` restricts reconciliation to a single namespace. By default the
operator is cluster-wide. `--no-watch` disables k8s watch streams and
falls back to interval-driven polling.
