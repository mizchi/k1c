# ADR-0003: Manifest dialect — Argo Rollouts subset + annotations + minimal CRDs

- Status: Accepted
- Date: 2026-05-08

## Context

Pure upstream Kubernetes primitives (`Deployment`, `Service`, `ConfigMap`, `Secret`, `CronJob`, `PersistentVolumeClaim`) cover much but not all of what k1c users need on Cloudflare. Two gaps drive this ADR.

### Gap 1: Progressive delivery

Cloudflare Workers exposes Versions and Gradual Deployments — percentage-based traffic split between two versions of the same Worker. Plain `Deployment` has no schema for this; its `RollingUpdate` strategy is built around pod replicas, which do not exist on Workers.

The de facto standard for progressive delivery on Kubernetes is **Argo Rollouts**, whose `Rollout` CRD replaces `Deployment` and adds `strategy.blueGreen` and `strategy.canary.steps`.

### Gap 2: Cloudflare-specific resources

Hyperdrive, Vectorize, AI Gateway, Browser Rendering, Email Workers, Queues, Pipelines, Smart Placement, Tail Workers — none of these have a Kubernetes analog. Stuffing them into `ConfigMap` or annotations on `Deployment` is dishonest.

## Decision

The k1c manifest dialect is composed of three layers, in order of preference:

1. **Vanilla Kubernetes core resources** — `Deployment`, `Service`, `ConfigMap`, `Secret`, `CronJob`, `PersistentVolumeClaim`. Used wherever a clean Cloudflare mapping exists. Pod-shape constraints (`maxSurge`, `nodeSelector`, etc.) that have no Cloudflare meaning are silently ignored with a warning.
2. **Argo Rollouts CRD subset** — `Rollout` resource with `strategy.blueGreen` and `strategy.canary.steps` (`setWeight`, `pause`). `trafficRouting`, `analysis`, and `experiment` are not implemented in v0; their presence triggers a warning. Why borrow rather than invent: progressive delivery vocabulary already exists, is widely understood, and translates cleanly to Cloudflare Versions / Gradual Deployments.
3. **k1c-native CRDs** under `cloudflare.k1c.io/v1alpha1`, only for resources with no Kubernetes analog: `R2Bucket`, `KVNamespace`, `D1Database`, `Queue`, `DurableObjectClass`, `CustomHostname`, `CronTrigger` (when the schedule features go beyond standard `CronJob`), `Hyperdrive`, `Vectorize`. New CRDs are added grudgingly and require their own short ADR.
4. **Annotations** under `cloudflare.com/*` for hints that should not be CRDs: `cloudflare.com/smart-placement`, `cloudflare.com/observability`, `cloudflare.com/compatibility-date`, `cloudflare.com/compatibility-flags`. Annotations are the right shape because they are by definition implementation-specific hints in Kubernetes.

### What we explicitly will not do

- We will not redefine vanilla resource semantics. `Service.spec.type=LoadBalancer` always means "expose externally"; how it maps to Cloudflare (Custom Domain vs Workers Routes) is implementation detail.
- We will not silently extend vanilla resource schemas with Cloudflare fields. Anything Cloudflare-specific goes through annotations or CRDs.

## Consequences

- A k1c manifest with all `cloudflare.com/*` annotations stripped and all `cloudflare.k1c.io/*` CRDs removed should still apply cleanly to a real Kubernetes cluster (assuming Argo Rollouts is installed). This is the portability test.
- Users learn three dialects layered on Kubernetes: vanilla, Argo Rollouts, and `cloudflare.k1c.io/v1alpha1`. Documentation must be honest about which is which.
- Argo Rollouts schema is vendored, not depended on. We support a defined subset; growing it requires a follow-up ADR.

## Alternatives considered

- **Define our own progressive-delivery CRD** (e.g., `WorkerRollout`). Rejected: invents private vocabulary for a problem the ecosystem has already solved.
- **Use only annotations, no new CRDs.** Rejected: cramming `R2Bucket` into a `ConfigMap` annotation is unreadable and breaks `kubectl get`.
- **Use Crossplane Composite Resources.** Rejected: adds a heavy framework with its own runtime requirements; users without Crossplane installed locally cannot reuse the manifests.
