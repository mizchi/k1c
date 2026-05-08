# TODO

Resources, mappings, and operational features that have a credible k8s-shape but are
not yet implemented. Roughly grouped by theme; not strictly ordered.

The high-priority items (StatefulSet → DurableObject, D1, Queue) are tracked separately
because they're being worked on now; everything below sits in the queue until someone
asks.

See also `docs/future-considerations.md` for items that are explicitly waiting on
upstream Cloudflare changes (Workers VPC, Workflows-as-runtime, async polling).

## Workload primitives we still don't model

- **`Job` → Workflow** — k8s `batch/v1 Job` (run to completion, `backoffLimit`,
  `restartPolicy: OnFailure`) maps cleanly to Cloudflare Workflows: each container
  becomes a `step.do()`, retry policy carries through. Pairs naturally with the
  existing `CronJob` story (CronJob is a scheduled Job).
- **`Ingress` → Worker Routes** — `spec.rules[].host` + `paths[]` lowering to
  zone-scoped Workers Routes. Needs a router Worker for path-based fan-out.
  `Service` (LoadBalancer → Custom Domain) handles the simple case today.

## Data plane

- **`D1Database` (CRD)** — managed SQL, the obvious peer to R2 / KV / Hyperdrive.
  *(in progress)*
- **`Vectorize` (CRD)** — vector index for RAG / AI workloads, same shape as D1
  (just a different `storageClass`).
- **`Queue` (CRD) + producer/consumer wiring** — producer Worker has a `queue`
  binding, consumer Worker is wired via `cloudflare.com/queue-consumer: <name>`
  annotation. *(in progress)*

## Stateful patterns

- **`StatefulSet` → Durable Object** — ordinal-stable identities; migration tag
  generated from `new_classes` / `renamed_classes` / `deleted_classes`. *(in progress)*

## Networking & DNS

- **`DNSRecord` (CRD)** under `cloudflare.k1c.io/v1alpha1`. Most useful when paired
  with `Service type=LoadBalancer`: an annotation `cloudflare.com/manage-dns: true`
  could auto-emit the A/AAAA/CNAME record alongside the Custom Domain.
- **`CustomHostname` (CRD)** — Cloudflare for SaaS routing. Async SSL provisioning
  forces async polling on the provider, which is why this is gated on the polling
  feature in `future-considerations.md`.
- **`Ingress` (`networking.k8s.io/v1`)** — see "Workload primitives".

## Observability / logging

- **`LogpushJob` (CRD)** — per-zone or per-account log push to S3 / GCS / R2 / etc.
  Roughly the manifest analog of a Fluent Bit DaemonSet config in real k8s.

## Identity / authorization (Zero Trust)

- **`AccessApplication` (CRD)** — Cloudflare Access application protecting a
  hostname. `spec.policies[]` references `AccessPolicy` resources.
- **`AccessPolicy` (CRD)** — `decision: allow|deny|bypass|non_identity` plus
  `include` / `exclude` / `require` rule groups. Closest k8s analog is Istio
  `AuthorizationPolicy`; the schema is non-trivial.

## Bindings only (no manifest of their own)

These are bound to Workers via `WorkerBinding` kinds; no separate CRD needed,
just annotation or `volumeMounts[].xxxRef` plumbing.

- **Workers AI** — `cloudflare.com/ai: enabled` annotation → `ai` binding on the
  Worker. No separate CF resource.
- **Browser Rendering** — `cloudflare.com/browser: enabled` annotation → `browser`
  binding. Same shape as Workers AI.
- **Analytics Engine** — annotation → `analytics_engine` binding with a dataset
  name. Already in the SDK binding union.
- **Version Metadata** — `cloudflare.com/version-metadata: enabled` →
  `version_metadata` binding, useful for Workers that want to know their own
  deploy id at runtime.

## Account-level configuration (out of the per-Pod manifest scope)

These are zone- or account-level and feel awkward to express as Pod-shaped
manifests. Likely better as their own top-level k1c CRD group rather than
dragged into `Deployment`.

- **Cache Rules** (zone-scoped).
- **Transform Rules** (zone-scoped, request / response rewrites).
- **WAF Custom Rules** (zone-scoped).
- **Rate Limiting Rules**.
- **Page Rules** (legacy).
- **Email Routing** rules.

## Media-heavy products (low fit, defer)

- **Stream** (video). CRD `Stream`. Mostly an upload + per-asset metadata story,
  not really a Pod-shaped thing.
- **Images**. Same shape as Stream.

## Operational features

- **`k1c apply --watch`** — re-apply on file change. Pairs with content hashing.
- **`k1c logs <kind> <name>`** — wrap `wrangler tail`.
- **`k1c port-forward`** — only meaningful if running against `wrangler dev`.
- **JSON output mode** (`--output=json`) for `get` / `describe` / `diff`.
- **Real Cloudflare e2e tests** — env-gated, in `tests/e2e/`. Currently every
  provider is exercised through SDK mocks only.
- **Reverse-topo on deletes** (see `future-considerations.md`).

## Nice-to-haves

- **Helm chart compatibility** (selective). Most charts won't translate, but a
  passing test for "trivial NGINX-on-k1c chart" would prove the boundary.
- **`kustomize` overlays** as a first-class concept (today they Just Work because
  we accept whatever YAML the parser sees, but a doc page on the supported subset
  would help).
- **Renovate / dependabot config** for the repo itself.
- **`pnpm publish` / npm package** distribution so `npm i -g @mizchi/k1c` works.
