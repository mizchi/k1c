# TODO

Resources, mappings, and operational features that have a credible k8s-shape but are
not yet implemented. Roughly grouped by theme; not strictly ordered.

See also `docs/future-considerations.md` for items that are explicitly waiting on
upstream Cloudflare changes (Workers VPC, Workflows-as-runtime, async polling).

## Workload primitives still missing

- *(none — `Ingress` shipped via generated router Worker + per-host Custom Domain)*

## Data plane

- *(none — R2 / KV / D1 / Hyperdrive / Vectorize are all shipped)*

## Networking & DNS

- **`CustomHostname` (CRD)** — Cloudflare for SaaS routing. Async SSL provisioning
  forces async polling on the provider, which is why this is gated on the polling
  feature in `future-considerations.md`.
- **DNSRecord auto-emission** — currently `DNSRecord` is its own resource. A
  `cloudflare.com/manage-dns: true` annotation on a `Service type=LoadBalancer`
  could auto-emit a CNAME pointing at the Custom Domain.

## Observability / logging

- *(all caught up — `LogpushJob` shipped)*

## Identity / authorization (Zero Trust)

- ~~**`AccessApplication` (CRD)**~~ — shipped (self_hosted type only). Inline
  policies: `decision: allow|deny|bypass|non_identity` + `include` / `exclude`
  / `require` rule groups. Supported rule shapes: `email`, `emailDomain`,
  `everyone`, `ip`, `country`, `serviceToken`, `anyValidServiceToken`.
- ~~**`AccessPolicy` (CRD)**~~ — shipped. Reusable account-level policy keyed
  on `k1c-<ns>-<name>`; AccessApplication's `policies[]` accepts either an
  inline policy or `{ ref: <name> }` which lowers to a
  `<resolved-at-apply:AccessPolicy:<label>>` placeholder substituted at apply
  time.
- **More AccessApplication types** — `self_hosted`, `ssh`, `vnc`, `bookmark`
  shipped. SaaS / Infrastructure / Browser Isolation each have their own
  dedicated fields (SAML/OIDC config for SaaS, target connectors for
  Infrastructure) and warrant separate follow-ups.

## Bindings only (no manifest of their own)

These are bound to Workers via `WorkerBinding` kinds; no separate CRD needed,
just annotation or `volumeMounts[].xxxRef` plumbing.

- ~~**Workers AI**~~ — shipped. `cloudflare.com/ai: <name>` (or `enabled` for
  default `AI`) Pod annotation.
- ~~**Browser Rendering**~~ — shipped. `cloudflare.com/browser-rendering: <name>`
  (or `enabled` for default `BROWSER`).
- ~~**Analytics Engine**~~ — shipped. `volumes[].analyticsEngineRef.dataset` →
  `analytics_engine` binding via volumeMount.
- ~~**Version Metadata**~~ — shipped. `cloudflare.com/version-metadata: <name>`
  (or `enabled` for default `CF_VERSION`).
- ~~**MTLS Certificate**~~ — shipped. `volumes[].mtlsCertificateRef.certificateId`
  + `volumeMounts[].mountPath` → `mtls_certificate` Worker binding. The cert
  must already be uploaded out-of-band (no MTLSCertificate CRD yet).
- ~~**Pipelines**~~ — shipped. `volumes[].pipelinesRef.pipelineId` →
  `pipelines` Worker binding. The pipeline must already exist (no Pipeline CRD).

## Recently shipped (was on this list, now done)

- ~~`Ingress` (`networking.k8s.io/v1`)~~ — shipped. Generates a router Worker
  with `service` bindings to backend Services, plus one Custom Domain per
  literal host. k8s `Prefix` semantics (segment-wise prefix); longest-path-first
  match within a host. Wildcard hosts (`*.example.com`) bind via Workers Routes
  (`<host>/*`) to the same router.
- ~~`LogpushJob` (CRD)~~ — shipped. Zone- or account-scoped log push to R2 / S3 /
  GCS / etc. Ownership marker via the `name` prefix `k1c-<ns>-<name>`.
- ~~AI / Browser / VersionMetadata bindings via Pod annotation~~ — shipped.
- ~~Analytics Engine binding via `volumes[].analyticsEngineRef`~~ — shipped.
- ~~`Job` → Workflow~~ — shipped. Job manifest emits a Worker + a `Workflow`
  registration via `cloudflare.workflows.update`.
- ~~`Vectorize` (CRD)~~ — shipped. Same shape as D1, with `volumes[].vectorizeRef`
  plumbing through to a `vectorize` Worker binding.
- ~~`DNSRecord` (CRD)~~ — shipped. Comment-based ownership marker
  (`k1c.io/managed=<ns>/<name>`), supports `A` / `AAAA` / `CNAME` / `TXT` / `MX`.
- ~~`D1Database` / `Queue` / `StatefulSet → DurableObject`~~ — shipped in the
  prior round.

## Account-level configuration (out of the per-Pod manifest scope)

These are zone- or account-level and feel awkward to express as Pod-shaped
manifests. Likely better as their own top-level k1c CRD group rather than
dragged into `Deployment`.

- ~~**Cache Rules**~~ — shipped as `CacheRule` CRD. Each k1c CacheRule maps to
  one rule inside the zone's `http_request_cache_settings` phase ruleset;
  ownership is tracked via the rule's description (`k1c.io/managed=<label>`)
  and non-k1c rules in the same ruleset are preserved across mutations.
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

- ~~**`k1c apply --watch`**~~ — shipped.
- ~~**JSON output mode**~~ — shipped (`-o json` on `get` / `describe` / `diff`).
- ~~**Reverse-topo on deletes**~~ — shipped. Deletes are now ordered by a
  static type priority (CustomDomain / Workflow / DNSRecord / LogpushJob →
  Worker → R2 / KV / D1 / Hyperdrive / Vectorize / Queue → DispatchNamespace),
  mirroring the create direction in reverse.
- **`k1c logs <kind> <name>`** — wrap `wrangler tail`.
- **`k1c port-forward`** — only meaningful if running against `wrangler dev`.
- ~~**`--quiet` mode**~~ — shipped (`-q` / `--quiet` on `apply`). Errors still
  flow to stderr; only the per-op progress on stdout is suppressed.
- ~~**Real Cloudflare e2e tests**~~ — harness shipped in `tests/e2e/` with
  `K1C_E2E=1` opt-in (auto-skips otherwise). Initial coverage: R2Bucket and
  KVNamespace full CRUD. Worker / Hyperdrive / D1 / Access / Cache Rule e2e
  follow-ups are easy to add against the same harness.

## Nice-to-haves

- **Helm chart compatibility** (selective). Most charts won't translate, but a
  passing test for "trivial NGINX-on-k1c chart" would prove the boundary.
- **`kustomize` overlays** as a first-class concept (today they Just Work because
  we accept whatever YAML the parser sees, but a doc page on the supported subset
  would help).
- **Renovate / dependabot config** for the repo itself.
- ~~**npm package** distribution~~ — shipped (`@mizchi/k1c` on npm via release-please + OIDC).
