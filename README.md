# k1c

Experimental `kubectl apply`-style tool for Cloudflare. Pronounced **"kick"**.

This is a learning / proof-of-concept project. It is **not production-ready**, and its public surface is subject to breaking changes without notice.

## What it does

`k1c` parses a defined subset of Kubernetes manifests and applies them to a Cloudflare account via the official SDK. The motivation is to reuse `kubectl`-style declarative manifests for personal-scale Cloudflare projects without paying for a real Kubernetes control plane.

```yaml
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
          volumeMounts:
            - { name: bucket, mountPath: R2_MEDIA }
      volumes:
        - { name: bucket, r2BucketRef: { name: media } }
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

| Manifest kind | Backed by | State |
|---|---|---|
| `Deployment` (single- or multi-container Pods) | Worker(s) wired by service bindings | working |
| `ConfigMap` / `Secret` | folded into Worker `vars` / `secrets` | working |
| `Service` (`ClusterIP` / `LoadBalancer`) | service binding / Custom Domain | working |
| `R2Bucket`, `KVNamespace`, `D1Database`, `Vectorize`, `Hyperdrive` (CRDs) | matching CF data services | working |
| `Queue` (CRD) + producer / consumer wiring | Cloudflare Queues + consumer | working |
| `DispatchNamespace` (CRD) | Workers for Platforms namespace | working |
| `Rollout` (Argo Rollouts subset, `blueGreen` / `canary.steps`) | Worker Versions, or WfP dispatcher with KV-stored canary state | working |
| `StatefulSet` → `DurableObject` class | Workers Durable Objects + migrations | working (greenfield only) |
| `CronJob` / `Job` | Worker + Cron Trigger / Workflow registration | working |
| `DNSRecord` (CRD) | DNS records | working |
| `LogpushJob` (CRD) | Logpush (zone- or account-scoped) | working |
| `ai` / `browser` / `version_metadata` / `analytics_engine` Worker bindings | annotation- / volume-driven | working |
| `Ingress` (`networking.k8s.io/v1`) | generated router Worker + Custom Domain per literal host (Workers Route per wildcard host) | working |
| `AccessApplication` (CRD; `self_hosted` / `ssh` / `vnc` / `biso` / `saas` / `infrastructure` / `bookmark`) | Cloudflare Access app with inline or referenced policies | working |
| `AccessPolicy` (CRD) | reusable account-level Access policy (referenced by `policies[].ref`) | working |
| `CacheRule` (CRD) | Cache Rule inside the zone's cache_settings phase ruleset | working |
| `TransformRule` (CRD) | request header rewrite inside the late_transform phase ruleset | working |
| `URIRewriteRule` (CRD) | URI path / query rewrite inside the http_request_transform phase | working |
| `ResponseHeaderRule` (CRD) | response header rewrite inside the http_response_headers_transform phase | working |
| `WAFCustomRule` (CRD) | block / challenge / log inside the firewall_custom phase ruleset | working |
| `WAFManagedRuleset` (CRD) | opt-in to a Cloudflare-managed WAF rule group (OWASP Core / Managed / etc.) | working |
| `RateLimitRule` (CRD) | request-rate threshold inside the http_ratelimit phase ruleset | working |
| `CustomHostname` (CRD) | Cloudflare for SaaS hostname with async SSL provisioning (polled) | working |
| `EmailRoutingRule` (CRD) | per-zone email routing (forward / drop / dispatch to Worker) | working |
| `TelemetryStack` (CRD) | bundle Logpush streams (workers / http / firewall / dns / audit) in one manifest | working |
| `CustomHostname` | — | not implemented (see [`TODO.md`](TODO.md)) |

See [`docs/resources.md`](docs/resources.md) for the full mapping and limitations,
and [`TODO.md`](TODO.md) for what's queued.

## Compatibility with real Kubernetes

A k1c manifest is a *subset* of valid k8s YAML — the same file can be
applied to either k1c or to a real `kubectl` cluster. Cloudflare-specific
data sources ride on the standard k8s `volumes[].csi` shape with k1c
driver names (`r2.k1c.io`, `kv.k1c.io`, `d1.k1c.io`, ...) and Cloudflare
CRDs live under `cloudflare.k1c.io/v1alpha1`.

To make `kubectl apply --dry-run=server` accept the Cloudflare CRDs,
register them once on the target cluster:

```sh
k1c export-crds | kubectl apply -f -
kubectl apply -f my-manifest.yaml --dry-run=server   # validates schema
```

The CSI drivers are not actually registered on the cluster, so a real
Pod will stay pending — but the manifest is schema-valid and admission
controllers accept it. k1c reads the same manifest and translates the
CSI driver / volumeAttributes into Worker bindings on the Cloudflare side.

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

Once published:

```sh
npm install -g @mizchi/k1c
# or:
pnpm dlx @mizchi/k1c apply -f manifest.yaml
```

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
K1C_E2E=1 K1C_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm test:e2e
```

## CLI

```sh
k1c apply    -f <file|dir|-> [--dry-run | --watch | --validate-only] [--quiet | -q]
k1c diff     -f <manifest.yaml> [-o text|json]
k1c delete   -f <manifest.yaml> [--cascade]
k1c get      <kind> [name] [-n <namespace>] [-o text|json]
k1c describe <kind> <name> [-n <namespace>] [-o text|json]
k1c rollout  {status|promote|abort} <ns>/<name> --dispatch <name>
k1c logs     <kind> <name> [-n <namespace>] [--format pretty|json] [--status <s>] [--limit N]
k1c port-forward <kind> <name> [-n <namespace>] [--port 8787]
k1c telemetry workers <kind> <name> [-n <ns>] [--since 1h] [-o text|json]
k1c explain  <kind | list> [--recursive | -r]
k1c config   list | current-context | use-context <name>
             | set-context <name> --account <id> [--zone <id>] [--token-env <env>]
             | delete-context <name>
k1c version
```

`logs` and `port-forward` shell out to a locally-installed `wrangler`
(`wrangler tail` and `wrangler dev --remote`, respectively). Resource kind
must lower to a Worker (`Deployment`, `Rollout`, `CronJob`, `Job`,
`StatefulSet`, or `Worker` itself).

Authentication is via two environment variables:

| Variable | Purpose |
|---|---|
| `K1C_ACCOUNT_ID` | Cloudflare account id (legacy fallback when no context is selected) |
| `K1C_ZONE_ID` | optional default zone id; lets `<resolved-at-apply:Context:zoneId>` placeholders resolve and `get/describe` enumerate zone-scoped resources |
| `CLOUDFLARE_API_TOKEN` | API token with Workers Edit + R2 + KV + Analytics Read (legacy fallback) |
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
