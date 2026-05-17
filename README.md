# k1c

Experimental `kubectl apply`-style tool for Cloudflare. Pronounced **"kick"**.

This is a learning / proof-of-concept project. The CLI + operator are
both published (`@mizchi/k1c` on npm, `ghcr.io/mizchi/k1c-operator`
on GHCR), but the public surface is subject to breaking changes
without notice.

## What it does

`k1c` parses a defined subset of Kubernetes manifests and applies them
to a Cloudflare account via the official SDK. The motivation is to
reuse `kubectl`-style declarative manifests for personal-scale
Cloudflare projects without paying for a real Kubernetes control
plane. Same manifest can be applied either via the CLI (one-shot) or
via the operator running inside any k8s cluster (continuous
reconciliation, finalizer-driven cascade delete).

```yaml
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: { location: weur }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          volumeMounts:
            - { name: bucket, mountPath: /mnt/media }
      volumes:
        - name: bucket
          csi:
            driver: r2.k1c.io
            volumeAttributes: { bucketRef: media, binding: R2_MEDIA }
```

```sh
$ K1C_ACCOUNT_ID=...  CLOUDFLARE_API_TOKEN=... pnpm k1c apply -f manifest.yaml
```

`-f` accepts a path, a directory (every `.yaml` / `.yml` recursively;
files named `_*` and `.*` are skipped), or `-` for stdin — so the rest of
the k8s ecosystem composes naturally:

```sh
helm template ./examples/helm-chart | k1c apply -f -
kustomize build ./examples/kustomize/overlays/prod | k1c apply -f -
```

## Status

23 Cloudflare CRD kinds + 9 standard k8s kinds are wired today.
"e2e" means the row is exercised by `tests/e2e/idempotency.e2e.test.ts`
against a real Cloudflare account — round-trip create → read →
equals → delete. "verified" rows were checked manually but aren't in
the suite (they need a customer domain / paid feature).

| Manifest kind | Backed by | State |
|---|---|---|
| `Deployment` (single- or multi-container Pods) | Worker(s) wired by service bindings | verified |
| `ConfigMap` / `Secret` | folded into Worker `vars` / `secrets` | derived |
| `Service` (`ClusterIP` / `LoadBalancer`) | service binding / Custom Domain | derived |
| `R2Bucket` (CRD) | R2 buckets | **e2e** |
| `KVNamespace` (CRD) | KV namespaces | **e2e** |
| `D1Database` (CRD) | D1 databases | **e2e** |
| `Vectorize` (CRD) | Vectorize indexes | **e2e** |
| `Hyperdrive` (CRD) | Hyperdrive configs | drift-fixed |
| `Queue` (CRD) + producer / consumer wiring | Cloudflare Queues + consumer | **e2e** |
| `DispatchNamespace` (CRD) | Workers for Platforms namespace | working (paid) |
| `AIGateway` (CRD) | Cloudflare AI Gateway | working |
| `Rollout` (Argo Rollouts subset, `blueGreen` / `canary.steps`) | Worker Versions, or WfP dispatcher with KV-stored canary state | working |
| `StatefulSet` → `DurableObject` class / `cloudflare.com/agent-classes` | Workers Durable Objects + Cloudflare Agents migrations | working (greenfield only) |
| `CronJob` / `Job` | Worker + Cron Trigger / Workflow registration | working |
| `DNSRecord` (CRD) | DNS records | **e2e** |
| `LogpushJob` (CRD) | Logpush (zone- or account-scoped) | drift-fixed |
| `TelemetryStack` (CRD) | bundle Logpush streams (workers / http / firewall / dns / audit) in one manifest | working |
| `dispatch_namespace` / `worker_loader` / `ai` / AI Gateway vars / `browser` / `images` / `version_metadata` / `analytics_engine` / `mtls` / `pipelines` Worker bindings | annotation- / volume-driven | working |
| `Ingress` (`networking.k8s.io/v1`) | generated router Worker + Custom Domain per literal host (Workers Route per wildcard host) | working |
| `WorkerRoute` (Ingress wildcard host) | Workers Route binding | verified |
| `CustomDomain` (CRD) | per-Worker Custom Domain | working |
| `CustomHostname` (CRD) | Cloudflare for SaaS hostname with async SSL provisioning (polled) | drift-fixed |
| `AccessApplication` (CRD; `self_hosted` / `ssh` / `vnc` / `biso` / `saas` / `infrastructure` / `bookmark`) | Cloudflare Access app with inline or referenced policies | **e2e** |
| `AccessPolicy` (CRD) | reusable account-level Access policy (referenced by `policies[].ref`) | **e2e** |
| `CacheRule` (CRD) | Cache Rule inside the zone's cache_settings phase ruleset | **e2e** |
| `TransformRule` (CRD) | request header rewrite inside the late_transform phase ruleset | **e2e** |
| `URIRewriteRule` (CRD) | URI path / query rewrite inside the http_request_transform phase | **e2e** |
| `ResponseHeaderRule` (CRD) | response header rewrite inside the http_response_headers_transform phase | **e2e** |
| `WAFCustomRule` (CRD) | block / challenge / log inside the firewall_custom phase ruleset | **e2e** |
| `WAFManagedRuleset` (CRD) | opt-in to a Cloudflare-managed WAF rule group (OWASP Core / Managed / etc.) | working |
| `RateLimitRule` (CRD) | request-rate threshold inside the http_ratelimit phase ruleset | **e2e** |
| `EmailRoutingRule` (CRD) | per-zone email routing (forward / drop / dispatch to Worker) | **e2e** |
| `PageRule` (CRD) | legacy zone-level page rules | drift-fixed |
| `StreamLiveInput` (CRD) | RTMPS / SRT ingest endpoint with recording policy | drift-fixed |

See [`docs/resources.md`](docs/resources.md) for the full mapping and limitations,
and [`TODO.md`](TODO.md) for what's queued.

**drift-fixed** = provider has a custom `equals` that strips
Cloudflare-side defaults (e.g. `proxied: false`, `storage_class:
'Standard'`, `recording.mode: 'off'`) so re-applying an unchanged
manifest stays NOOP. The pattern was uncovered while running the e2e
suite against a real account — see PRs #25 / #27 / #29 / #35 / #36 /
#37 / #38.

## Operator: real-time reconciliation inside a k8s cluster

For users who want `kubectl apply` to actually reach Cloudflare (not just
sit in etcd), `k1c operator run` watches CRD instances + label-gated
standard resources and reconciles them via the same lower / plan / apply
pipeline the CLI uses. See [`examples/k1c-operator/`](examples/k1c-operator/)
for the install bundle (ServiceAccount + ClusterRole + Deployment), the
[helm chart](examples/k1c-operator/helm-chart/), and an
[Argo CD GitOps install example](examples/argocd/).

```
GitOps (Argo CD / Flux) ──► etcd ──watch──► k1c operator ──► Cloudflare API
```

The operator runs the same code path as the CLI, so a feature added to
either ships to both at once. Production-grade plumbing:

- **Watch streams**: subscribes to every Cloudflare CRD plural + label-gated standard kind, debounced 500ms; `--interval` doubles as a resync safety net; `--no-watch` falls back to pure polling.
- **Status writeback**: after each reconcile pass, patches `.status.conditions` on every touched Cloudflare CRD so `kubectl get r2bucket` reflects `Reconciled` / `ReconcileFailed` plus the underlying error message; `.status.cloudflareNativeId` is persisted for the cleanup path.
- **Finalizer cascade delete**: every CR carries a `k1c.io/cleanup` finalizer. `kubectl delete` flips `deletionTimestamp`; the operator deletes the corresponding Cloudflare resource and strips the finalizer; k8s GCs the CR. Failures retry on the next tick.
- **Leader election** (`coordination.k8s.io/v1` Lease): scale `replicas` to 2+ for HA, leader/standby spread by `topologySpreadConstraints`. Failover within ~15s.
- **Prometheus `/metrics`** + `/healthz` + `/readyz` on `:9090`. ServiceMonitor template + Grafana dashboard included. Metrics: `k1c_operator_{up, is_leader, reconcile_total, reconcile_passes_total, reconcile_duration_seconds, watch_events_total, managed_resources, finalizer_total}`.
- **Structured JSON logging** via `--log-format json` for log aggregators.
- **Graceful shutdown**: SIGTERM waits up to 30s for the in-flight reconcile to finish before exiting.

## PKL: type-checked manifests

[PKL](https://pkl-lang.org) is a configuration language with strong
types and module imports. PKL manifests catch typos / missing fields /
out-of-range enums at *edit* time instead of at apply time:

```pkl
// examples/pkl/hello-worker.pkl
import "../../pkl/k1c.pkl"

output {
  renderer = new YamlRenderer { isStream = true }
  value = resources
}

resources = new Listing {
  new k1c.R2Bucket {
    metadata { name = "media" }
    spec { location = "weur" }   // ← `"antarctica"` fails with line+col
  }
  new k1c.Deployment { ... }
}
```

```sh
# Either pipe pkl yourself …
pkl eval --format yaml examples/pkl/hello-worker.pkl | k1c apply -f -

# … or just hand the .pkl file directly. The CLI shells to
# `pkl eval --format yaml` when it sees a `.pkl` extension.
k1c apply -f examples/pkl/hello-worker.pkl
```

Three example layouts under [`examples/pkl/`](examples/pkl/) show how
far the typed approach scales:

| layout | what it shows |
|--------|---------------|
| [`hello-worker.pkl`](examples/pkl/hello-worker.pkl) | single file, 1:1 with `examples/hello-worker.yaml` |
| [`saas/`](examples/pkl/saas/) | multi-env composition: `_stack-web.pkl` / `_stack-api.pkl` reused by `dev.pkl` and `prod.pkl` via `amends`, with `when (envName == "prod")` branching |
| [`multi-tenant/`](examples/pkl/multi-tenant/) | external JSON list driving `for (t in tenants) ...` comprehension to fan out R2 + KV + per-tier Workers + a shared router |

CI runs `k1c apply --validate-only` on every `.pkl` example
([k8s-validate.yml](.github/workflows/k8s-validate.yml)) so a rename
in the zod schemas, a CSI driver change, or a PKL syntax slip fails
the build before it lands. Reproduce locally with:

```sh
just validate-pkl
```

Hand-written modules ship under [`pkl/`](pkl/) and currently cover
the most-used kinds (R2Bucket / KVNamespace / D1Database / Queue /
Vectorize / ConfigMap / Secret / Deployment with CSI volumes). The
long tail of CRDs (rulesets, Access*, etc.) stays YAML-only until
`k1c export-pkl` can generate the full set from the zod schemas.

## Wasm component build (preview)

The CLI compiles to a [WebAssembly Component](https://component-model.bytecodealliance.org/)
via `pnpm build:wasm`. The pipeline:

1. `tsc` emits the JS sources.
2. `esbuild` bundles `dist/cli/wasm-main.js` (a Node-free entry that
   drops `operator`, `logs`, `port-forward`, `rollout`, `config`, and
   `apply --watch` — see [`src/cli/wasm-main.ts`](src/cli/wasm-main.ts))
   into a single ~1.8 MB ESM module at `dist-wasm/k1c.bundle.mjs`.
3. `componentize-js` (optional) wraps the bundle in a `wasi:cli/run`
   component at `dist-wasm/k1c.wasm`. This step needs the wasi-cli
   WIT packages vendored under [`wit/deps/`](wit/) — see the
   `wit/README.md` for the vendoring procedure. If the deps are
   missing the script logs the failure but still emits the bundle, so
   you can re-componentize out-of-band.

The bundle works in any wasi-cli host once wrapped. `apply` /
`diff` / `get` / `describe` / `delete` / `telemetry` / `explain` /
`export-crds` / `version` are the supported commands.

## Compatibility with real Kubernetes

A k1c manifest is a *subset* of valid k8s YAML — the same file applies
to either k1c or to a real `kubectl` cluster. Cloudflare-specific data
sources ride on the standard `volumes[].csi` shape with k1c driver
names (`r2.k1c.io`, `kv.k1c.io`, `dispatch-namespace.k1c.io`, ...)
and Cloudflare CRDs
live under `cloudflare.k1c.io/v1alpha1`.

Worker binding names are resolved from CSI `volumeAttributes` in this order:
`binding`, legacy `bindingName`, then an upper-snake derivation from the volume
name (`r2-media` -> `R2_MEDIA`). `mountPath` stays a Kubernetes mount path and is
not used as the Worker binding name. A container's `image` is the Worker script
entrypoint path; for manifests that need a Kubernetes-looking placeholder,
`cloudflare.com/source.<container-name>` can override it.

### Dual-path lowering

Both entry points share one schema source (`src/manifest/schemas.ts`,
zod):

```
                         src/manifest/schemas.ts (zod)
                                     ↑
              ┌──────────────────────┴──────────────────────┐
              │                                             │
    k1c apply -f m.yaml                          kubectl apply -f m.yaml
    (CLI parses zod directly)            (apiserver validates against
              │                            openAPIV3Schema, derived
              │                            from the same zod by
              │                            `k1c export-crds`)
              │                                             │
              │                                CR stored in etcd
              │                                             │
              │                            operator watches → reconciles
              │                            (re-parses with the same zod
              │                             at src/operator/source.ts)
              │                                             │
              └──────────►  Cloudflare API  ◄───────────────┘
                            (same lower / plan / apply path)
```

To register the CRDs once on the target cluster:

```sh
k1c export-crds | kubectl apply -f -
kubectl apply -f my-manifest.yaml --dry-run=server   # validates schema
```

The CSI drivers are not registered on the cluster, so a real Pod stays
pending — but the manifest is schema-valid and admission controllers
accept it. To make `kubectl apply` actually reach Cloudflare, install
the operator (see [Operator section](#operator-real-time-reconciliation-inside-a-k8s-cluster)).

### What CI gates which path

| Path | What it verifies | Where |
|------|------------------|-------|
| CLI | every example lowers cleanly through zod | [`src/examples-smoke.test.ts`](src/examples-smoke.test.ts) |
| apiserver schema | `kubectl apply --dry-run=server` against registered CRDs | [`k8s-validate.yml`](.github/workflows/k8s-validate.yml) (`k8s-validate` job) |
| operator | apply a CR → operator reacts → finalizer attached → cascade delete | [`k8s-validate.yml`](.github/workflows/k8s-validate.yml) (`operator-e2e` job) |
| HA | replicas=2, single-leader invariant, lease handover within ~15s | [`k8s-validate.yml`](.github/workflows/k8s-validate.yml) (`operator-ha-e2e` job) |
| PKL → CLI | every `.pkl` example lowers cleanly via the same zod path | [`k8s-validate.yml`](.github/workflows/k8s-validate.yml) (PKL validation step) |

So a schema-breaking change shows up on every PR through whichever
path it affects, and a feature added to either entry point ships to
both at once.

### Asymmetry to know about

The CLI accepts standard k8s kinds (`Deployment` / `Service` /
`ConfigMap` / `Secret` / ...) and translates them into Worker /
binding equivalents. A real cluster handles those as native k8s
resources, not as Cloudflare ones. So:

- For Cloudflare-only resources (R2Bucket, KVNamespace, D1Database, Queue, Vectorize, ...): apply either via `k1c apply` or via `kubectl apply` (with the operator installed). Both paths converge.
- For `Deployment` etc.: `k1c apply` lowers it to a Cloudflare Worker; `kubectl apply` creates a real k8s Deployment. Pick the path that matches what you actually want.

The operator only watches `cloudflare.k1c.io/v1alpha1` CRDs plus
label-gated standard kinds — see
[`src/operator/source.ts`](src/operator/source.ts) for the gate
predicate. That keeps "I just wanted a regular k8s Deployment" cases
out of the Cloudflare reconcile loop.

## Examples

[`examples/`](examples/) carries one self-contained manifest per supported
pattern (multi-container Pod, blueGreen / canary Rollout, CronJob,
StatefulSet / Durable Object, Hyperdrive, Queue producer + consumer,
AI + Vectorize RAG stack, multi-tenant SaaS, zone hardening combo,
full-stack web app, etc.). Browse [`examples/README.md`](examples/README.md)
for the full index. Each file is exercised by
[`src/examples-smoke.test.ts`](src/examples-smoke.test.ts) so the library
stays in sync with the schemas.

## Why this exists

I wanted a `kubectl apply` UX for personal Cloudflare projects but did not want to pay for a managed Kubernetes control plane (GKE minimum is roughly JPY 8,000 / month). `k1c` is the smallest tool that lets a Kubernetes-shaped manifest drive Cloudflare resources directly. See [ADR-0001](docs/adr/0001-project-goal.md) for the full reasoning.

The architecture is documented as [Architecture Decision Records](docs/adr/) (ADR-0001 through ADR-0007).

## Install

CLI (one-shot apply):

```sh
npm install -g @mizchi/k1c
# or:
pnpm dlx @mizchi/k1c apply -f manifest.yaml
```

Operator (continuous reconciliation inside a k8s cluster):

```sh
# Register CRDs once (kept out of the helm release lifecycle so
# `helm uninstall` doesn't orphan every CR you ever applied).
k1c export-crds | kubectl apply -f -

# API token Secret.
kubectl create namespace k1c-system
kubectl -n k1c-system create secret generic cloudflare-api-token \
  --from-literal=K1C_ACCOUNT_ID=<your-account-id> \
  --from-literal=CLOUDFLARE_API_TOKEN=<your-token>

# Either: flat install bundle.
kubectl apply -f https://raw.githubusercontent.com/mizchi/k1c/main/examples/k1c-operator/install.yaml

# Or: helm chart.
helm install k1c examples/k1c-operator/helm-chart \
  --namespace k1c-system --create-namespace=false

# Or: Argo CD Application — see examples/argocd/.
```

The operator image is published as a multi-arch (`linux/amd64` +
`linux/arm64`) OCI v1.1 image with SLSA provenance + SBOM
attestations: `ghcr.io/mizchi/k1c-operator:<version>`.

From source (this repo):

```sh
pnpm install
pnpm test          # offline unit + integration tests (uses SDK mocks)
pnpm typecheck
pnpm build         # emits dist/

# Run the CLI in-repo (TypeScript via Node strip-types):
pnpm k1c apply   -f examples/hello-worker.yaml [--dry-run]

# Optional: end-to-end tests against a real Cloudflare account (creates and
# deletes resources). Requires K1C_E2E=1 plus the same env vars used by the CLI.
# The full suite needs the permissions listed in the Authentication section.
K1C_E2E=1 K1C_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm test:e2e
```

## CLI

```sh
k1c apply    -f <file|dir|-> [--dry-run | --watch | --validate-only] [--quiet | -q]
k1c diff     -f <manifest.yaml> [-o text|json] [-v|--verbose] [--color always|never]
k1c delete   -f <manifest.yaml> [--cascade]
k1c get      <kind> [name] [-n <namespace>] [-o text|json]
k1c describe <kind> <name> [-n <namespace>] [-o text|json]
k1c rollout  {status|promote|abort} <ns>/<name> --dispatch <name>
k1c logs     <kind> <name> [-n <namespace>] [--format pretty|json] [--status <s>] [--limit N]
k1c port-forward <kind> <name> [-n <namespace>] [--port 8787]
k1c wrangler-config -f <manifest.yaml> [--worker <namespace/name>]
k1c telemetry workers <kind> <name> [-n <ns>] [--since 1h] [-o text|json]
k1c explain  <kind | list> [--recursive | -r]
k1c export-crds [--include-standard]
k1c config   list | current-context | use-context <name>
             | set-context <name> --account <id> [--zone <id>] [--token-env <env>]
             | delete-context <name>
k1c operator run [-n <namespace>] [--interval 30] [--no-watch]
                 [--leader-election] [--lease-name k1c-operator]
                 [--lease-namespace k1c-system]
                 [--metrics-addr 0.0.0.0:9090 | --no-metrics]
                 [--log-format text|json]
k1c version
```

`logs` and `port-forward` shell out to a locally-installed `wrangler`
(`wrangler tail` and `wrangler dev --remote`, respectively). Resource kind
must lower to a Worker (`Deployment`, `Rollout`, `CronJob`, `Job`,
`StatefulSet`, or `Worker` itself).

`wrangler-config` is an offline bridge for local Worker dev. It parses and
lowers the same manifest as `apply`, selects one lowered Worker, and prints a
`wrangler.jsonc`-compatible JSON config with `main`, compatibility settings,
and Worker bindings, including Workers AI `ai`, Dynamic Workers `worker_loaders`,
Workers for Platforms `dispatch_namespaces`, and Agents Durable Object
bindings/migrations. If the manifest lowers to multiple Workers, pass
`--worker default/api` (or another `<namespace>/<name>` label). JSON is valid
JSONC, so the output can be used directly as a Wrangler config. Resource IDs
that k1c resolves only at apply time are omitted from the generated config,
leaving binding names explicit while keeping local dev usable.

Authentication is via two environment variables:

| Variable | Purpose |
|---|---|
| `K1C_ACCOUNT_ID` | Cloudflare account id (legacy fallback when no context is selected) |
| `K1C_ZONE_ID` | optional default zone id; lets `<resolved-at-apply:Context:zoneId>` placeholders resolve and `get/describe` enumerate zone-scoped resources |
| `CLOUDFLARE_API_TOKEN` | API token for the Cloudflare resources in the manifest (legacy fallback). For the broad examples/e2e suite, use account permissions: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Queues Edit, Vectorize Edit, AI Gateway Edit, Workers AI Read, Access Apps and Policies Edit, plus zone permissions needed by zone resources such as DNS Edit, Zone WAF Edit, Transform Rules Edit, Cache Rules Edit, Email Routing Edit, and Page Rules Edit. |
| `K1C_CONTEXT` | name of a context defined in `~/.k1c/config.yaml` to use; `--context <name>` flag overrides this |
| `K1C_CONFIG` | path to the context file (default: `~/.k1c/config.yaml`) |

For multi-account / multi-zone setups, use `k1c config set-context` to record
each environment's account / zone / API token env-var name in
`~/.k1c/config.yaml`, then switch with `k1c config use-context <name>` or per
invocation with `--context <name>`. Tokens themselves stay in env vars
(`apiTokenEnv` only stores the var *name*) so the file is safe to share
across machines.

## Architecture in one screen

```
manifest.yaml
   │
   ▼  src/manifest/parse.ts        — YAML → typed K1cResource[] (validated by zod)
   │
   ▼  src/manifest/lower.ts        — resolves refs, folds ConfigMap/Secret into Workers,
   │                                  generates DispatcherWorker / state KV for canary Rollouts
   ▼  src/reconciler/plan.ts       — compares desired vs actual via providers, topological sort
   │
   ▼  src/reconciler/apply.ts      — executes operations (create/update/delete) with retry
   │
   ▼  src/canary/runtime.ts        — for canary Rollouts: read KV state, run state machine,
   │                                  upload canary + rewrite weight + promote
   ▼  Cloudflare account
```

Providers live under `src/providers/` and are uniform across resource types. The interface mirrors AWS CloudControl (CRUD + Status + List + Discovery); see [ADR-0006](docs/adr/0006-provider-interface.md).

## Limitations

This is experimental. In particular:

- Worker entrypoint content is hashed at lower time and round-tripped via the
  `k1c.io/content-hash=` script tag, so editing only the JS file (without
  changing the manifest) now triggers a Worker update on apply.
- Async polling: providers can return `kind: 'async'` from create / update; the
  apply loop polls `status()` until success / failure (used by `CustomHostname`).
- The reconciler model assumes a single Cloudflare account at a time.
- End-to-end coverage is opt-in (`tests/e2e/**`, env-gated by `K1C_E2E=1`). The
  default `pnpm test` exercises providers against SDK mocks only; running the
  e2e suite requires a real Cloudflare account and creates / deletes resources
  there. See `Releases` and `Limitations` below for what is and is not covered.

## Releases

Versioning is automated via [release-please](https://github.com/googleapis/release-please-action):

- Conventional Commit messages on `main` (`feat:`, `fix:`, `chore:`, etc.) feed
  into a release PR that bumps `package.json`, updates `CHANGELOG.md`, and
  cuts a Git tag plus a GitHub Release.
- The same `release-please.yml` workflow then runs a `publish` job (gated on
  `release_created == true`) that publishes `@mizchi/k1c` to npm via
  [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers)
  (no `NPM_TOKEN`) with `--provenance` SLSA attestation.

The npm package must be registered as a trusted publisher on `npmjs.com` once,
pointing at `mizchi/k1c` + the `release-please.yml` workflow. After that the
entire flow (PR → merge → tag → npm) is hands-off.

## License

MIT
