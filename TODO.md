# TODO

Resources, mappings, and operational features that have a credible k8s-shape but are
not yet implemented. Roughly grouped by theme; not strictly ordered.

See also `docs/future-considerations.md` for items that are explicitly waiting on
upstream Cloudflare changes (Workers VPC, Workflows-as-runtime, async polling).

## End-to-end verification checklist

Code is exercised by 464 mock-based tests today, but real-world round-trips
against actual Cloudflare and actual k8s have not happened. Each box below
is "tried it, it worked" vs "no one has run it yet". Use the `nix develop`
shell (kind + kubectl + helm + kustomize preinstalled) for k8s-side checks.

### Cloudflare API round-trips (env-gated, K1C_E2E=1 + real token)

- [ ] R2Bucket — full CRUD via `tests/e2e/r2-bucket.e2e.test.ts`
- [ ] KVNamespace — full CRUD via `tests/e2e/kv-namespace.e2e.test.ts`
- [ ] D1Database — full CRUD via `tests/e2e/d1-database.e2e.test.ts`
- [ ] AccessPolicy — full CRUD via `tests/e2e/access-policy.e2e.test.ts`
- [ ] CacheRule — full CRUD via `tests/e2e/cache-rule.e2e.test.ts` (also needs K1C_ZONE_ID)
- [ ] Worker + KV binding (placeholder resolution end-to-end) — `tests/e2e/worker-with-bindings.e2e.test.ts`
- [ ] Hyperdrive — needs a reachable Postgres origin; e2e harness pending
- [ ] Vectorize / Queue / Workflow / DispatchNamespace — e2e harness pending
- [ ] LogpushJob / TelemetryStack / TelemetryAggregator — needs an R2 destination + zone
- [ ] CustomDomain / CustomHostname — needs a real zone + DCV; one-shot test acceptable
- [ ] WAF{Custom,Managed}Rule / RateLimitRule / TransformRule / URIRewriteRule / ResponseHeaderRule — single-zone, low-risk e2e
- [ ] EmailRoutingRule — needs zone with Email Routing enabled
- [ ] AccessApplication (self_hosted / ssh / vnc / biso / saas / infrastructure / bookmark) — at least one type per branch
- [ ] WorkerRoute (Ingress wildcard host) — needs zone
- [ ] DNSRecord auto-emission via Service `cloudflare.com/manage-dns` annotation
- [ ] Canary Rollout state machine on a real DispatchNamespace (5% → 25% → 100%)

### k1c CLI smoke (offline)

- [x] `k1c version` (npm install path)
- [x] `k1c version` (docker pull path, image entry point)
- [x] `k1c apply --validate-only` on a sample manifest
- [x] `k1c explain R2Bucket` schema dump
- [ ] `k1c diff -v` against a real Cloudflare account (color + per-field diff visible)
- [ ] `k1c rollout status / promote / abort` against a real DispatchNamespace
- [ ] `k1c logs <kind> <name>` shells out to a real `wrangler tail`
- [ ] `k1c port-forward` shells out to a real `wrangler dev --remote`
- [ ] `k1c telemetry workers <kind> <name>` against the Analytics GraphQL API

### k8s side (use `nix develop` to get kind/kubectl/helm/kustomize)

- [x] `kind create cluster --name k1c-test` succeeds
- [x] `k1c export-crds | kubectl apply -f -` registers all 21 CRDs
- [x] `kubectl explain r2bucket.cloudflare.k1c.io` returns the kind metadata
- [x] `kubectl apply --dry-run=server -f examples/<every>.yaml` passes schema validation (every example file fixed: every Deployment/Rollout/StatefulSet now has `template.metadata.labels` matching its selector; every CronJob/Job has `restartPolicy: OnFailure`; every Service has `ports`; every Ingress backend has `port.number`)
- [x] `helm template ./examples/helm-chart | kubectl apply --dry-run=server -f -` passes
- [x] `kustomize build ./examples/kustomize/base | kubectl apply --dry-run=server -f -` passes
- [x] `kustomize build ./examples/kustomize/overlays/prod | kubectl apply --dry-run=server -f -` passes (after `kubectl create namespace prod`)

### Operator (Phase 1: polling)

- [x] `kind load docker-image k1c-operator:dev` + Deployment with `imagePullPolicy: Never` starts up cleanly inside the kind cluster
- [x] `(k1c operator starting; account=... cluster-wide interval=10000ms)` is the first log line
- [x] Reconcile loop fires every interval; "no managed resources found" when etcd is empty
- [x] `kubectl apply` of an `R2Bucket` CRD instance is picked up on the next reconcile pass
- [x] Cloudflare API failure surfaces as a structured `[NotFound] 404 ...` log line (not `[object Object]`)
- [ ] Operator picks up label-gated standard kinds (`k1c.io/managed=true` Deployment / etc.)
- [ ] Operator forwards changes to Cloudflare on a real account
- [ ] Operator survives a kubectl-side delete and reverse-topo deletes the Cloudflare side
- [ ] OCI image (`ghcr.io/mizchi/k1c-operator:latest`) pulls + runs on linux/amd64
- [ ] OCI image pulls + runs on linux/arm64

### Distribution

- [x] npm provenance attestation present on `@mizchi/k1c@0.9.0`
- [x] OCI image index multi-arch (amd64 + arm64) at ghcr.io/mizchi/k1c-operator:0.9.0
- [ ] OCI image SBOM attestation surfaces in `cosign download attestation`
- [ ] OCI image SLSA provenance attestation surfaces in `cosign verify-attestation`

## Workload primitives still missing

- *(none — `Ingress` shipped via generated router Worker + per-host Custom Domain)*

## Data plane

- *(none — R2 / KV / D1 / Hyperdrive / Vectorize are all shipped)*

## Networking & DNS

- ~~**`CustomHostname` (CRD)**~~ — shipped. Returns `kind: 'async'` from create
  and exposes a `status()` method the apply loop polls until the hostname's
  status is `active` and the SSL cert is `active`. Ownership tracked via the
  `custom_metadata['k1c.io/managed']` field on each hostname. In-place SSL
  config update is supported via `customHostnames.edit`; hostname rename
  still surfaces as `NotUpdatable` + `suggest=recreate`.
- ~~**DNSRecord auto-emission**~~ — shipped. `Service type=LoadBalancer` with
  `cloudflare.com/manage-dns: 'true'` now auto-emits a proxied CNAME record
  pointing at the hostname (override the content with
  `cloudflare.com/dns-content: ...`).

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
- ~~**More AccessApplication types**~~ — `self_hosted` / `ssh` / `vnc` /
  `biso` / `saas` / `infrastructure` / `bookmark` all shipped. SaaS uses
  a raw passthrough `saasApp` field for the SAML/OIDC config (k1c does not
  model the protocol-specific shape); Infrastructure uses a similar raw
  `targetCriteria` array. dash_sso / app_launcher / warp / rdp are not yet
  exposed but are single-enum follow-ups if needed.

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

- ~~**Cache Rules**~~ — shipped as `CacheRule` CRD.
- ~~**Transform Rules**~~ — shipped as `TransformRule` (request headers,
  `http_request_late_transform`), `URIRewriteRule` (URI path / query,
  `http_request_transform`), and `ResponseHeaderRule` (response headers,
  `http_response_headers_transform`). All three reuse `_ruleset-shared` for
  RMW + ownership.
- ~~**WAF Custom Rules**~~ — shipped as `WAFCustomRule` CRD (block / challenge /
  log in `http_request_firewall_custom`). Cloudflare-managed rule groups live
  in a different phase and are not in scope.
- ~~**Rate Limiting Rules**~~ — shipped as `RateLimitRule` CRD (in `http_ratelimit`).
  All four ruleset CRDs share `_ruleset-shared.ts` for the read-modify-write
  plumbing.
- **Page Rules** (legacy).
- ~~**Email Routing**~~ — shipped as `EmailRoutingRule` CRD. Supports
  literal-`to` and catch-all matchers; forward / drop / worker actions.
  Ownership encoded in the rule's `name` field via `k1c:` prefix.

## Media-heavy products (low fit, defer)

- **Stream** (video). CRD `Stream`. Mostly an upload + per-asset metadata story,
  not really a Pod-shaped thing.
- **Images**. Same shape as Stream.

## Telemetry

- ~~**Per-Worker Logpush via annotation**~~ — shipped. Deployment / Rollout /
  CronJob / Job / StatefulSet with `cloudflare.com/logpush: <destinationConf>`
  auto-emits a LogpushJob filtered to that Worker's trace events. The
  resolver substitutes `<resolved-at-apply:Context:accountId>` with the
  apply ctx so lower stays decoupled from env.
- ~~**`k1c telemetry workers`**~~ — shipped. Queries the GraphQL Analytics
  API for invocations / errors / CPU+wall p99 over a `--since` window.
- ~~**Telemetry stack CRD**~~ — shipped as `TelemetryStack`. Bundles up to
  five streams (workersTrace / httpRequests / firewallEvents / dnsLogs /
  auditLogs) under one resource; lowers to one LogpushJob per enabled
  stream. Zone-scoped streams require `spec.zoneId`; account-scoped streams
  resolve `accountId` from the apply context.
- ~~**Aggregator Worker template**~~ — shipped. `TelemetryStack.spec.aggregator`
  generates a Worker that receives Logpush HTTP batches, HMAC-verifies the
  request, and fans out to Queue / R2 / OTLP (any subset). Streams set
  `viaAggregator: true` to ship to the aggregator hostname instead of a
  static destination URL.

## Operational features

- ~~**`k1c apply --watch`**~~ — shipped.
- ~~**JSON output mode**~~ — shipped (`-o json` on `get` / `describe` / `diff`).
- ~~**Reverse-topo on deletes**~~ — shipped. Deletes are now ordered by a
  static type priority (CustomDomain / Workflow / DNSRecord / LogpushJob →
  Worker → R2 / KV / D1 / Hyperdrive / Vectorize / Queue → DispatchNamespace),
  mirroring the create direction in reverse.
- ~~**`k1c logs <kind> <name>`**~~ — shipped. Shells out to `wrangler tail`,
  translating Deployment/Rollout/CronJob/Job/StatefulSet to the underlying
  `k1c--<ns>--<name>` Worker script name.
- ~~**`k1c port-forward`**~~ — shipped. Shells out to `wrangler dev --remote`
  on the resolved script, binding to the requested local port.
- ~~**`--quiet` mode**~~ — shipped (`-q` / `--quiet` on `apply`). Errors still
  flow to stderr; only the per-op progress on stdout is suppressed.
- ~~**Real Cloudflare e2e tests**~~ — harness shipped in `tests/e2e/` with
  `K1C_E2E=1` opt-in (auto-skips otherwise). Coverage: R2Bucket, KVNamespace,
  D1Database full CRUD, plus a Worker-with-KV-binding integration test that
  validates the placeholder resolution layer end-to-end against real
  Cloudflare. Hyperdrive (needs a real DB origin) / Access / CacheRule /
  CustomHostname e2e are easy follow-ups.

## Nice-to-haves

- ~~**Helm chart compatibility**~~ — shipped. `-f` accepts stdin (`-`) so
  `helm template <chart> | k1c apply -f -` is the canonical pattern. A
  minimal example chart lives in `examples/helm-chart/` and the integration
  test parses the output `helm template` would emit.
- ~~**`kustomize` overlays**~~ — shipped. Same stdin pipe pattern, plus
  `-f <directory>` for direct multi-file apply. `examples/kustomize/`
  has a base + prod overlay demonstrating namespace propagation, multi-file
  resources, and JSON-Patch transforms; the rendered output is exercised
  in the integration test.
- **Renovate / dependabot config** for the repo itself.
- ~~**npm package** distribution~~ — shipped (`@mizchi/k1c` on npm via release-please + OIDC).
