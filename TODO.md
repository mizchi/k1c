# TODO

Resources, mappings, and operational features that have a credible k8s-shape but are
not yet implemented. Roughly grouped by theme; not strictly ordered.

See also `docs/future-considerations.md` for items that are explicitly waiting on
upstream Cloudflare changes (Workers VPC, Workflows-as-runtime, async polling).

## End-to-end verification checklist

Code is exercised by 464 mock-based tests today; the rows below track real
round-trips against actual Cloudflare and actual k8s. Each box is "tried
it, it worked" vs "no one has run it yet". Use the `nix develop` shell
(kind + kubectl + helm + kustomize preinstalled) for k8s-side checks.

Most recent verification session (0.9.0):

- All 7 k8s-side rows ticked on a kind cluster: CRD registration via
  `k1c export-crds | kubectl apply -f -`, `kubectl explain` for the
  Cloudflare CRDs, every `examples/*.yaml` through `kubectl apply
  --dry-run=server`, `helm template … | kubectl apply --dry-run=server -f
  -`, and the kustomize base + prod overlay through the same pipe.
- 6/12 operator rows ticked: pod boots inside kind, reconcile loop fires
  on the configured interval, an `R2Bucket` instance added via `kubectl
  apply` is detected on the next pass, the resulting Cloudflare API call
  fails with a structured `[NotFound] 404 ...` line (against a dummy
  account — the loop itself is healthy). Label-gated standard kinds
  (Deployment with `k1c.io/managed=true`) are also detected: the
  reconcile-error path changes when the manifest's annotation-based
  source is added, proving the operator reads everything end-to-end.
- 5/5 distribution rows ticked: `ghcr.io/mizchi/k1c-operator:0.9.0`
  pulls + runs on both `linux/amd64` and `linux/arm64`; SLSA provenance
  + SBOM (SPDX 2.3, syft v1.42.3, 255 packages) attached as OCI 1.1
  referrer manifests, retrievable via `docker buildx imagetools inspect
  ... --format '{{json .Provenance|.SBOM}}'`.

Side effect: 14 example manifests + the helm-chart and kustomize-base
deployments needed `template.metadata.labels` (matching the selector),
`restartPolicy` on Job/CronJob templates, `Service.spec.ports`, and
`Ingress.backend.service.port.number` to pass strict k8s validation.
None of those fields affect k1c's lower step; they were missing because
the manifest only had to satisfy the k1c schema before. Now the same
manifest passes both. See commit "fix: every example passes kubectl apply
--dry-run=server".

### Cloudflare API round-trips (env-gated, K1C_E2E=1 + real token)

- [x] R2Bucket — full CRUD via `tests/e2e/r2-bucket.e2e.test.ts`
- [x] KVNamespace — full CRUD via `tests/e2e/kv-namespace.e2e.test.ts`
- [x] D1Database — full CRUD via `tests/e2e/d1-database.e2e.test.ts`
- [x] AccessPolicy — full CRUD via `tests/e2e/access-policy.e2e.test.ts`
- [x] CacheRule — full CRUD via `tests/e2e/cache-rule.e2e.test.ts` (also needs K1C_ZONE_ID)
- [x] Worker + KV binding (placeholder resolution end-to-end) — `tests/e2e/worker-with-bindings.e2e.test.ts`
- [x] Vectorize / Queue — covered by `tests/e2e/idempotency.e2e.test.ts`
- [x] WAFCustomRule / RateLimitRule / TransformRule / URIRewriteRule / ResponseHeaderRule — covered by `tests/e2e/idempotency.e2e.test.ts`
- [x] DNSRecord — covered by `tests/e2e/idempotency.e2e.test.ts`
- [x] EmailRoutingRule — verified manually (mizchi.net zone, Email Routing enabled)
- [x] AccessApplication (self_hosted) — verified manually
- [x] WorkerRoute — verified manually
- [ ] Hyperdrive — token scope or feature not enabled on free account
- [ ] DispatchNamespace / Workflow — needs Workers for Platforms (paid)
- [ ] WAFManagedRuleset — needs Enterprise
- [ ] StreamLiveInput — needs Stream subscription on the account
- [ ] PageRule — Cloudflare account-owned tokens (cfat_*) reject the legacy Page Rules endpoint; needs a user-owned token
- [ ] LogpushJob / TelemetryStack / TelemetryAggregator — `destination_conf` requires R2 access keys (separate API)
- [ ] CustomDomain / CustomHostname — needs a real zone + DCV; one-shot test acceptable
- [ ] DNSRecord auto-emission via Service `cloudflare.com/manage-dns` annotation
- [ ] Canary Rollout state machine on a real DispatchNamespace (5% → 25% → 100%)

### k1c CLI smoke (offline + real account)

- [x] `k1c version` (npm install path)
- [x] `k1c version` (docker pull path, image entry point)
- [x] `k1c apply --validate-only` on a sample manifest
- [x] `k1c explain R2Bucket` schema dump
- [x] `k1c apply -f hello-worker.yaml --dry-run` (real account)
- [x] `k1c apply -f hello-worker.yaml` — full create round-trip (R2 + KV + Worker)
- [x] `k1c apply -f hello-worker.yaml` again — re-apply is 3 NOOP / 0 drift
- [x] `k1c diff -f hello-worker.yaml -v` (per-field diff)
- [x] `k1c get / describe / delete --cascade` against real account
- [x] `k1c telemetry workers <kind> <name>` against the Analytics GraphQL API (text + json)
- [ ] `k1c rollout status / promote / abort` against a real DispatchNamespace (needs WfP)
- [ ] `k1c logs <kind> <name>` shells out to a real `wrangler tail`
- [ ] `k1c port-forward` shells out to a real `wrangler dev --remote`

### k8s side (use `nix develop` to get kind/kubectl/helm/kustomize)

- [x] `kind create cluster --name k1c-test` succeeds
- [x] `k1c export-crds | kubectl apply -f -` registers all 21 CRDs
- [x] `kubectl explain r2bucket.cloudflare.k1c.io` returns the kind metadata
- [x] `kubectl apply --dry-run=server -f examples/<every>.yaml` passes schema validation (every example file fixed: every Deployment/Rollout/StatefulSet now has `template.metadata.labels` matching its selector; every CronJob/Job has `restartPolicy: OnFailure`; every Service has `ports`; every Ingress backend has `port.number`)
- [x] `helm template ./examples/helm-chart | kubectl apply --dry-run=server -f -` passes
- [x] `kustomize build ./examples/kustomize/base | kubectl apply --dry-run=server -f -` passes
- [x] `kustomize build ./examples/kustomize/overlays/prod | kubectl apply --dry-run=server -f -` passes (after `kubectl create namespace prod`)
- [x] CI gate (`.github/workflows/k8s-validate.yml`): every example +
      operator install bundle + helm + kustomize is dry-run validated
      against a kind cluster on every PR — catches the same
      strict-validation regressions before they merge

### Operator (Phase 1: polling, Phase 2: watch + status writeback)

- [x] `kind load docker-image k1c-operator:dev` + Deployment with `imagePullPolicy: Never` starts up cleanly inside the kind cluster
- [x] `(k1c operator starting; account=... cluster-wide interval=10000ms)` is the first log line
- [x] Reconcile loop fires every interval; "no managed resources found" when etcd is empty
- [x] `kubectl apply` of an `R2Bucket` CRD instance is picked up on the next reconcile pass
- [x] Cloudflare API failure surfaces as a structured `[NotFound] 404 ...` log line (not `[object Object]`)
- [x] Operator picks up label-gated standard kinds (`k1c.io/managed=true`
      Deployment with CSI volumes mounting an R2Bucket + KVNamespace —
      verified by error-path transitions: `kubectl annotate
      cloudflare.com/source.api=...` flips the next reconcile's ENOENT
      message from the original image to the annotation source path,
      proving lower walked the new manifest)
- [x] Operator forwards changes to Cloudflare on a real account (verified
      `kubectl apply r2bucket` → bucket appears at Cloudflare; `k1c get
      R2Bucket` from the CLI confirms via the same token)
- [x] Operator survives a `kubectl delete` and reverse-deletes the
      Cloudflare side via the `k1c.io/cleanup` finalizer flow (PR #26).
      `status.cloudflareNativeId` is persisted so the cleanup path
      knows the native id even after the spec is gone.
- [x] OCI image (`ghcr.io/mizchi/k1c-operator:0.9.0`) pulls + runs on linux/amd64 (`docker run --platform linux/amd64 ... version` → `k1c 0.9.0`)
- [x] OCI image pulls + runs on linux/arm64 (same, `--platform linux/arm64`)
- [x] Phase 2: watch streams (`src/operator/watch.ts`). Default-on; the
      reconcile loop subscribes to every Cloudflare CRD plural plus
      every label-gated standard kind, debounces events by 500ms, and
      uses the configured interval as a resync safety net. `--no-watch`
      falls back to pure polling.
- [x] Phase 3: status writeback (`src/operator/status.ts`). After each
      reconcile pass the operator patches `.status.conditions` on every
      touched Cloudflare CRD via the `/status` subresource (enabled in
      `export-crds`), so `kubectl get r2bucket` shows Ready /
      ReconcileFailed + the underlying error message. RBAC in
      `examples/k1c-operator/install.yaml` extended with `*/status`.

### Distribution

- [x] npm provenance attestation present on `@mizchi/k1c@0.9.0`
- [x] OCI image index multi-arch (amd64 + arm64) at `ghcr.io/mizchi/k1c-operator:0.9.0`
- [x] Both arches `docker pull --platform` + `docker run version` succeed
- [x] SBOM attestation present (SPDX 2.3, syft v1.42.3, 255 packages per arch);
      retrieved via `docker buildx imagetools inspect ... --format '{{json .SBOM}}'`
- [x] SLSA provenance attestation present (`buildType: …/buildkit/blob/master/docs/attestations/slsa-definitions.md`);
      retrieved via `... --format '{{json .Provenance}}'`. Note: cosign-style
      `verify-attestation` does NOT find these — buildx publishes them as
      OCI 1.1 referrer manifests (the two `unknown/unknown` manifests in the
      image index), not as cosign-tag attestations. Either tooling reads them
      via the OCI Referrers API; cosign requires `--type custom` plus a
      manual subject digest.

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
- ~~**Page Rules**~~ — shipped as `PageRule` CRD. Legacy zone-level
  rules engine; superseded by Cache / Transform / Response Header
  Rules but still works on un-migrated zones. Caveat: Cloudflare's
  Page Rules API has no comment / metadata field, so identity is
  derived from `(zoneId, url, priority)`. Two manifests with the same
  triple in the same zone collide.
- ~~**Email Routing**~~ — shipped as `EmailRoutingRule` CRD. Supports
  literal-`to` and catch-all matchers; forward / drop / worker actions.
  Ownership encoded in the rule's `name` field via `k1c:` prefix.

## Media-heavy products

- ~~**Stream Live Input**~~ — shipped as `StreamLiveInput` CRD. The
  long-lived RTMPS / SRT ingest endpoint with a configurable recording
  policy, allowed origins, signed-URL gate, and auto-purge window.
  Ownership tracked in the `meta` field via
  `meta['k1c.io/managed'] = "<ns>/<name>"`. Uploaded videos are still
  out of scope (one-shot binary blobs).
- **Images**. Similar binary-upload shape — out of scope.

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
- ~~**Renovate / dependabot config**~~ — shipped (`renovate.json`).
  Patch + dev-minor auto-merge; core libs (`@kubernetes/client-node`,
  `cloudflare`, `zod`) grouped; weekly schedule; lockfile maintenance.
- ~~**npm package** distribution~~ — shipped (`@mizchi/k1c` on npm via release-please + OIDC).
