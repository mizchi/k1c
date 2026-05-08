# ADR-0002: Translator architecture over a control plane

- Status: Accepted
- Date: 2026-05-08

## Context

Two architectural shapes were considered for k1c:

- **A. Control plane.** Run an API server (potentially on Cloudflare Workers + Durable Objects) that stores manifests, runs reconciliation loops, and exposes `kubectl`-compatible endpoints. The user `kubectl apply`s against this server.
- **B. Translator.** A CLI that reads manifests, computes a diff against the live Cloudflare account, and calls the Cloudflare API directly. No persistent server.

## Decision

Adopt **Translator** (option B).

`apply` is a one-shot operation: read manifest, query Cloudflare, diff, execute. No long-running process. No etcd-equivalent. No reconciliation loop. The "controller" is the user re-running `k1c apply` (manually, via CI, or via `argocd sync` / `flux reconcile` against a git repo).

## Consequences

- **No control plane to operate or pay for.** Aligns with the cost goal of ADR-0001.
- **No `kubectl exec`, `kubectl logs -f`, no admission webhooks, no continuous reconciliation.** These belong to a control plane and are explicit non-goals.
- **GitOps integration is shifted upstream.** ArgoCD/Flux can call `k1c apply` as a sync step, but k1c itself is not a GitOps server.
- **Drift detection is on-demand.** `k1c diff` queries Cloudflare and shows drift. There is no background watcher.
- **Multi-tenant deployments are the user's responsibility.** k1c assumes one Cloudflare account per invocation.

## Alternatives considered

- **A. Full control plane on Workers.** Rejected for two reasons:
  1. Workers cannot run pods, so the "compute substrate" of a normal k8s cluster does not exist. A control plane that schedules nothing but routes back to other Cloudflare resources is a glorified manifest store.
  2. Existing tools (k3s, kind, k0s) already cover the "real but lightweight k8s" niche. Building another control plane adds nothing.
- **C. Hybrid (translator with optional reconciliation daemon).** Deferred. The translator must work first. A daemon mode can be added later as a separate ADR if `apply` plus GitOps proves insufficient.
