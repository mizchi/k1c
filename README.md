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
| `Ingress` / `CustomHostname` / Zero Trust Access | — | not implemented (see [`TODO.md`](TODO.md)) |

See [`docs/resources.md`](docs/resources.md) for the full mapping and limitations,
and [`TODO.md`](TODO.md) for what's queued.

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
pnpm test          # 297 tests
pnpm typecheck
pnpm build         # emits dist/

# Run the CLI in-repo (TypeScript via Node strip-types):
pnpm k1c apply   -f examples/hello-worker.yaml [--dry-run]
```

## CLI

```sh
k1c apply    -f <manifest.yaml> [--dry-run | --watch]
k1c diff     -f <manifest.yaml> [-o text|json]
k1c delete   -f <manifest.yaml> [--cascade]
k1c get      <kind> [name] [-n <namespace>] [-o text|json]
k1c describe <kind> <name> [-n <namespace>] [-o text|json]
k1c rollout  {status|promote|abort} <ns>/<name> --dispatch <name>
k1c version
```

Authentication is via two environment variables:

| Variable | Purpose |
|---|---|
| `K1C_ACCOUNT_ID` | Cloudflare account id |
| `CLOUDFLARE_API_TOKEN` | API token with Workers Edit + R2 + KV permissions |

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

- Worker entrypoint content is not yet hashed at lower time, so editing only the JS file (without changing the manifest) does not currently trigger an update outside the canary path. Deferred (`docs/future-considerations.md`).
- Async polling for Custom Hostname SSL provisioning is not implemented.
- The reconciler model assumes a single Cloudflare account at a time.
- No real end-to-end tests against Cloudflare yet — provider behavior is validated through SDK mocks only.

## Releases

Versioning is automated via [release-please](https://github.com/googleapis/release-please-action):

- Conventional Commit messages on `main` (`feat:`, `fix:`, `chore:`, etc.) feed
  into a release PR that bumps `package.json`, updates `CHANGELOG.md`, and
  cuts a Git tag plus a GitHub Release.
- Merging that release PR triggers `.github/workflows/publish.yml`, which
  publishes `@mizchi/k1c` to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers)
  (no `NPM_TOKEN` involved) with `--provenance` SLSA attestation.

The npm package must be registered as a trusted publisher on `npmjs.com` once,
pointing at `mizchi/k1c` + the `publish.yml` workflow. After that the entire
flow (PR → merge → tag → npm) is hands-off.

## License

MIT
