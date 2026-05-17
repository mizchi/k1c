# k1c examples

Hands-on starting points for every supported pattern. Each YAML file is
self-contained — apply it on its own with:

```sh
K1C_ACCOUNT_ID=...  CLOUDFLARE_API_TOKEN=...  pnpm k1c apply -f <file> --dry-run
```

Replace `REPLACE_WITH_YOUR_*` placeholders before applying without
`--dry-run`. Every example is exercised by `src/examples-smoke.test.ts`,
so they stay in sync with the schemas.

## Single-Worker basics

| File | What it shows |
|---|---|
| [`hello-worker.yaml`](hello-worker.yaml) | minimal Worker + R2 + KV + ConfigMap |
| [`multi-container.yaml`](multi-container.yaml) | Pod with two containers wired by sibling service bindings |
| [`cronjob.yaml`](cronjob.yaml) | scheduled Worker via Cron Triggers (cron syntax + suspend) |
| [`statefulset-durable-object.yaml`](statefulset-durable-object.yaml) + [`counter-do.mjs`](counter-do.mjs) | StatefulSet → Durable Object class with per-id state |
| [`job-workflow.yaml`](job-workflow.yaml) | Job → Cloudflare Workflow registration |

## Progressive delivery

| File | What it shows |
|---|---|
| [`rollout-bluegreen.yaml`](rollout-bluegreen.yaml) | Argo Rollouts blueGreen — single cutover via Worker Versions + Deployments |
| [`rollout-canary.yaml`](rollout-canary.yaml) | Argo Rollouts canary on Workers for Platforms Dynamic Dispatch (5% → 25% → 50% → 100%, controlled by `k1c rollout {status,promote,abort}`) |

## Data + integrations

| File | What it shows |
|---|---|
| [`hyperdrive.yaml`](hyperdrive.yaml) | Hyperdrive pooled Postgres with password from a Secret |
| [`queue-producer-consumer.yaml`](queue-producer-consumer.yaml) | Cloudflare Queue with one producer Worker + one consumer Worker |
| [`ai-rag.yaml`](ai-rag.yaml) | RAG-style stack: Workers AI + Vectorize + R2 |
| [`ai-agent-gateway.yaml`](ai-agent-gateway.yaml) + [`ai-agent-worker.mjs`](ai-agent-worker.mjs) | Cloudflare Agents wired to Workers AI through an AI Gateway |

## Networking + routing

| File | What it shows |
|---|---|
| [`ingress-fanout.yaml`](ingress-fanout.yaml) | path-based routing via a generated router Worker |
| [`path-routing-with-access.yaml`](path-routing-with-access.yaml) | Ingress + Cloudflare Access on the same hostname |
| [`saas-multi-tenant.yaml`](saas-multi-tenant.yaml) | Cloudflare for SaaS (CustomHostname per tenant) + DispatchNamespace |
| [`dynamic-workers.yaml`](dynamic-workers.yaml) | Dynamic Workers Worker Loader + Workers for Platforms dispatch namespace binding |

## Zone-level configuration

| File | What it shows |
|---|---|
| [`cache-rule.yaml`](cache-rule.yaml) | single CacheRule on the cache_settings phase |
| [`zone-rules.yaml`](zone-rules.yaml) | Transform / WAF custom / RateLimit combo |
| [`zone-hardening.yaml`](zone-hardening.yaml) | full prod hardening pack: managed WAF + custom WAF + rate limit + cache + security response headers |
| [`email-routing.yaml`](email-routing.yaml) | per-zone email routing (forward / drop / dispatch to Worker) |

## Zero Trust

| File | What it shows |
|---|---|
| [`access-application.yaml`](access-application.yaml) | self_hosted AccessApplication with inline policies |
| [`access-policy.yaml`](access-policy.yaml) | reusable AccessPolicy referenced from an AccessApplication |
| [`access-bookmark.yaml`](access-bookmark.yaml) | App Launcher bookmark tile |

## Telemetry

| File | What it shows |
|---|---|
| [`telemetry-logpush.yaml`](telemetry-logpush.yaml) | per-Worker Logpush via `cloudflare.com/logpush` annotation (auto-emits a LogpushJob filtered to the Worker's trace events) |
| [`telemetry-stack.yaml`](telemetry-stack.yaml) | TelemetryStack — one manifest covering workers / http / firewall / dns / audit log shipping |
| [`telemetry-aggregator.yaml`](telemetry-aggregator.yaml) | TelemetryStack with a generated aggregator Worker that fans Logpush HTTP batches into Queue + R2 + OTLP |

Beyond the manifest side, `k1c telemetry workers <kind> <name>` queries the
GraphQL Analytics API for invocation count / error rate / CPU + wall time
p99 over the last `--since` window:

```sh
$ k1c telemetry workers Deployment api -n prod --since 1h
script:        k1c--prod--api
window:        last 1h (3600s)
requests:      1,234,567
subrequests:   1,420
errors:        1,205 (0.10%)
req/s:         342.935
cpu p99 (ms):  23.50
wall p99 (ms): 41.20
```

## Full-stack

| File | What it shows |
|---|---|
| [`fullstack-app.yaml`](fullstack-app.yaml) | one Worker + R2 + KV + D1 + ConfigMap + Secret + Service (LoadBalancer) + auto-emitted DNS, in a single file |

## k8s ecosystem

| Path | What it shows |
|---|---|
| [`helm-chart/`](helm-chart/) | minimal Helm chart you can `helm template ... | k1c apply -f -` |
| [`kustomize/`](kustomize/) | base + prod overlay you can `kustomize build ... | k1c apply -f -` (also: `k1c apply -f ./examples/kustomize/base`) |

## PKL (typed manifests)

`k1c apply -f <file>.pkl` shells to `pkl eval --format yaml` automatically.
Type errors land at edit time with line numbers instead of as zod failures
at apply time.

| Path | What it shows |
|---|---|
| [`pkl/hello-worker.pkl`](pkl/hello-worker.pkl) | single-file translation of `hello-worker.yaml` against [`pkl/k1c.pkl`](../pkl/k1c.pkl) |
| [`pkl/saas/`](pkl/saas/) | multi-environment composition: shared `_stack-*.pkl` modules amended by env-specific `dev.pkl` / `prod.pkl` |
| [`pkl/multi-tenant/`](pkl/multi-tenant/) | external `tenants.json` fanned out via `for (t in tenants) ...` into per-tenant R2 / KV / Worker resources |

## Runtime helpers

`hello-worker.mjs`, `counter-do.mjs`, `dynamic-platform.mjs`, and
`ai-agent-worker.mjs` are the JS entry points referenced by several manifests.
They are intentionally small — replace them with your real code. If you use the
Agents SDK package, point the manifest at your bundled output.

For local Worker development, generate a Wrangler config from any single-Worker
manifest:

```sh
pnpm k1c wrangler-config -f examples/hello-worker.yaml > wrangler.jsonc
```

If a manifest lowers to multiple Workers, select one with
`--worker <namespace/name>`.
