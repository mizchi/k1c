# k1c-operator helm chart

Alternative to the flat `examples/k1c-operator/install.yaml` bundle —
parameterized for namespace, image, replicas, leader election, and the
Cloudflare API secret name.

## Install

```sh
# 1. Register the Cloudflare CRDs (one-time per cluster).
k1c export-crds | kubectl apply -f -

# 2. Create the API token Secret in the operator's namespace.
kubectl create namespace k1c-system
kubectl -n k1c-system create secret generic cloudflare-api-token \
  --from-literal=K1C_ACCOUNT_ID=<your-account-id> \
  --from-literal=CLOUDFLARE_API_TOKEN=<your-token>

# 3. helm install.
helm install k1c examples/k1c-operator/helm-chart \
  --namespace k1c-system --create-namespace=false
```

## Common knobs

| value                            | default                            | what it does |
|----------------------------------|------------------------------------|--------------|
| `replicaCount`                   | `1`                                | bump to `2+` for HA; `--leader-election` is on by default |
| `image.repository`               | `ghcr.io/mizchi/k1c-operator`      | OCI image to run |
| `image.tag`                      | `""` → `Chart.AppVersion`          | pin to a specific release |
| `cloudflareSecretName`           | `cloudflare-api-token`             | Secret holding `K1C_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` |
| `operator.intervalSec`           | `30`                               | resync interval (also fallback when `--no-watch`) |
| `operator.watch`                 | `true`                             | open k8s watch streams; set false to fall back to polling |
| `operator.leaderElection`        | `true`                             | required for `replicaCount > 1` |
| `operator.metricsAddr`           | `0.0.0.0:9090`                     | empty disables /metrics, /healthz, /readyz |
| `operator.restrictNamespace`     | `""`                               | restrict reconciliation to a single namespace |
| `operator.logFormat`             | `text`                             | `text` for human consumption, `json` for log aggregators |
| `metricsService.enabled`         | `true`                             | emit a Service for Prometheus scrape |

## Why the chart doesn't ship CRDs

Helm's CRD lifecycle is confusing — `helm uninstall` deletes them,
which would orphan every CR you ever applied. By default the chart
keeps CRDs out: register them once via
`k1c export-crds | kubectl apply -f -` and they survive any
re-install / uninstall cycle.

If you really want them inside the chart, set `installCrds: true` —
but be ready to handle the orphan risk on uninstall.
