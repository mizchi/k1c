# k1c operator

Runs `k1c apply` continuously inside a real Kubernetes cluster. Watches
both the Cloudflare CRDs (`cloudflare.k1c.io/v1alpha1` group) and any
standard k8s resource carrying the label `k1c.io/managed=true`, then
forwards changes to Cloudflare via the same lower / plan / apply core
the CLI uses.

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
  2. Feeds them through the same `parseManifest → lower → plan → apply`
     pipeline `k1c apply -f` uses.
  3. Reports per-op status on stdout.

So the operator and the CLI share 99% of the implementation. A change to
the lower / plan / apply core ships to both at once.

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
  CLOUDFLARE_API_TOKEN   API token with Workers Edit + R2 + KV permissions
  K1C_ZONE_ID            (optional) default zone id

Container args:

  operator run [-n <namespace>] [--interval 30]

`-n` restricts reconciliation to a single namespace. By default the
operator is cluster-wide.
