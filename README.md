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
| `Deployment` | Worker (Versions + Deployments API, 100% cutover) | working |
| `ConfigMap` / `Secret` | folded into Worker `vars` / `secrets` | working |
| `R2Bucket` (CRD) | R2 bucket | working |
| `KVNamespace` (CRD) | KV namespace | working |
| `DispatchNamespace` (CRD) | Workers for Platforms namespace | working |
| `Rollout` (Argo Rollouts subset, blueGreen / canary.steps) | Worker Versions, or Workers for Platforms dispatcher with KV-stored canary state | working |
| `Service` / `Ingress` / `CustomHostname` | Worker Routes / Custom Domain | not implemented |
| `Job` / `StatefulSet` / `D1` / `Hyperdrive` / `Vectorize` / `Queue` | — | not implemented |

See [`docs/resources.md`](docs/resources.md) for the full mapping and limitations.

## Why this exists

I wanted a `kubectl apply` UX for personal Cloudflare projects but did not want to pay for a managed Kubernetes control plane (GKE minimum is roughly JPY 8,000 / month). `k1c` is the smallest tool that lets a Kubernetes-shaped manifest drive Cloudflare resources directly. See [ADR-0001](docs/adr/0001-project-goal.md) for the full reasoning.

The architecture is documented as [Architecture Decision Records](docs/adr/) (ADR-0001 through ADR-0007).

## Quick start

```sh
pnpm install
pnpm test          # 193 tests
pnpm typecheck

# the CLI:
pnpm k1c apply   -f examples/hello-worker.yaml [--dry-run]
pnpm k1c diff    -f examples/hello-worker.yaml
pnpm k1c rollout {status|promote|abort} <ns>/<name> --dispatch <name>
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

## License

MIT
