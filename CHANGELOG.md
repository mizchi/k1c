# Changelog

## [0.15.0](https://github.com/mizchi/k1c/compare/v0.14.0...v0.15.0) (2026-05-17)


### Features

* **providers:** add TurnstileWidget, Snippet, StreamKey, StreamWatermark ([#56](https://github.com/mizchi/k1c/issues/56)) ([d9ab07c](https://github.com/mizchi/k1c/commit/d9ab07c45d7787c81c715566a3466f0faa514fc8))

## [0.14.0](https://github.com/mizchi/k1c/compare/v0.13.0...v0.14.0) (2026-05-17)


### Features

* add WorkerCronTrigger + R2 bucket sidecar resources ([#53](https://github.com/mizchi/k1c/issues/53)) ([3c73bd6](https://github.com/mizchi/k1c/commit/3c73bd6d0a2a35b017bac6bca586652a0f310fee))
* **providers:** add WorkerVersion + WorkerDeployment for gradual rollout ([#55](https://github.com/mizchi/k1c/issues/55)) ([f60196d](https://github.com/mizchi/k1c/commit/f60196de7f23e266b1a541243a27b9b8ef28cb30))

## [0.13.0](https://github.com/mizchi/k1c/compare/v0.12.0...v0.13.0) (2026-05-17)


### Features

* AI Gateway provider, wrangler-config CLI, dynamic Workers for Platforms examples ([#51](https://github.com/mizchi/k1c/issues/51)) ([d885a8b](https://github.com/mizchi/k1c/commit/d885a8b55acf6b8f7610b6a4d88826e85eacf514))

## [0.12.0](https://github.com/mizchi/k1c/compare/v0.11.0...v0.12.0) (2026-05-10)


### Features

* drift-prevention for CustomHostname/StreamLiveInput + helm polish ([#37](https://github.com/mizchi/k1c/issues/37)) ([2e70d0c](https://github.com/mizchi/k1c/commit/2e70d0ced1d4ef16a9947ab79c695949dfdb3ec3))
* extend idempotency e2e + preemptive LogpushJob equals fix ([#36](https://github.com/mizchi/k1c/issues/36)) ([6bbd754](https://github.com/mizchi/k1c/commit/6bbd7541e226375d138eca8d947e8534d188168c))
* **pkl:** multi-environment SaaS example exercising composition ([#42](https://github.com/mizchi/k1c/issues/42)) ([ece86df](https://github.com/mizchi/k1c/commit/ece86df8cab331789af38725755be064b91c7ad1))
* **pkl:** multi-tenant example using external JSON + for-loop ([#43](https://github.com/mizchi/k1c/issues/43)) ([68fb1be](https://github.com/mizchi/k1c/commit/68fb1be03ef2d5fa4d3b61f0b543e79397a213ea))
* **pkl:** native .pkl manifest support + hand-written type modules ([#41](https://github.com/mizchi/k1c/issues/41)) ([d468757](https://github.com/mizchi/k1c/commit/d4687572e073dd73a8a0e2077aa6a01230ff4294))


### Bug Fixes

* **access-application:** re-apply NOOP for auto_redirect / allowed_idps defaults ([#29](https://github.com/mizchi/k1c/issues/29)) ([46787f3](https://github.com/mizchi/k1c/commit/46787f3066d19ec07e630716da16ca7f88d5bd64))
* **hyperdrive:** exclude write-only password from equals() ([#35](https://github.com/mizchi/k1c/issues/35)) ([79ef147](https://github.com/mizchi/k1c/commit/79ef1479c26257f3957713bb475a6289fe947c60))
* **page-rule:** preemptive equals normalize (status default + actions ordering) ([#38](https://github.com/mizchi/k1c/issues/38)) ([69cb4b0](https://github.com/mizchi/k1c/commit/69cb4b098c0e24ae2c16da870b2ef1ecabeff4cc))

## [0.11.0](https://github.com/mizchi/k1c/compare/v0.10.0...v0.11.0) (2026-05-10)


### Features

* **operator:** finalizer-driven cascade delete ([#26](https://github.com/mizchi/k1c/issues/26)) ([2516e30](https://github.com/mizchi/k1c/commit/2516e304163af2aa206e11865ca6401cd944f405))


### Bug Fixes

* **idempotency:** re-apply of unchanged manifest is now NOOP across the board ([#25](https://github.com/mizchi/k1c/issues/25)) ([fd55696](https://github.com/mizchi/k1c/commit/fd556961c2e3e01a57ff2fe5622d643db59b1632))
* **providers:** toProviderError pass-through on already-wrapped errors ([#21](https://github.com/mizchi/k1c/issues/21)) ([62708db](https://github.com/mizchi/k1c/commit/62708db243f14d87db93d3dcda50d14b77df4db9))
* **r2:** lowercase Cloudflare's location response so re-apply is idempotent ([#24](https://github.com/mizchi/k1c/issues/24)) ([931ee37](https://github.com/mizchi/k1c/commit/931ee3737f2f8c0e467cc3a3043f02979833f4d4))
* **vectorize,dns:** re-apply NOOP for default-valued fields ([#27](https://github.com/mizchi/k1c/issues/27)) ([f7e9ae4](https://github.com/mizchi/k1c/commit/f7e9ae409ef1f8fabce6883a7c4b4f3feefcfcc6))
* **worker,plan:** real-account e2e bugs uncovered against a live token ([#23](https://github.com/mizchi/k1c/issues/23)) ([873a3d4](https://github.com/mizchi/k1c/commit/873a3d4398c4c9f7b3e22670f118f0e6dd393def))

## [0.10.0](https://github.com/mizchi/k1c/compare/v0.9.0...v0.10.0) (2026-05-09)


### Features

* **crd:** real OpenAPIV3 schemas via zod-to-json-schema ([#18](https://github.com/mizchi/k1c/issues/18)) ([6ee30aa](https://github.com/mizchi/k1c/commit/6ee30aa9c6ab468bbd9e515c44be4535c67bd1fe))
* **helm:** ServiceMonitor template + Grafana starter dashboard ([#20](https://github.com/mizchi/k1c/issues/20)) ([d9572f1](https://github.com/mizchi/k1c/commit/d9572f1a9eb824915b241c5f8d316afcb4a4aa4c))
* operator phase 2 (watch streams) + phase 3 (status writeback) + CI gate ([#10](https://github.com/mizchi/k1c/issues/10)) ([73a9c3d](https://github.com/mizchi/k1c/commit/73a9c3d94728fe46e9bde4f49cffd33bac206708))
* **operator:** helm chart + graceful shutdown drain ([#16](https://github.com/mizchi/k1c/issues/16)) ([64b7de6](https://github.com/mizchi/k1c/commit/64b7de601474ad3dd31ad3a0822fb5a52ce34628))
* **operator:** JSON logging + Argo CD GitOps install example ([#19](https://github.com/mizchi/k1c/issues/19)) ([155e2ce](https://github.com/mizchi/k1c/commit/155e2ce5c4ac2d32cf909305d0d50a93a42dce40))
* **operator:** leader election via coordination.k8s.io/v1 Lease ([#14](https://github.com/mizchi/k1c/issues/14)) ([453da97](https://github.com/mizchi/k1c/commit/453da97b3e9e584eb6aca83845cc08f10a7eadf5))
* **operator:** Prometheus /metrics + /healthz + /readyz endpoint ([#13](https://github.com/mizchi/k1c/issues/13)) ([9e70891](https://github.com/mizchi/k1c/commit/9e70891946f6409d4ee7602321633e9516219e40))
* PageRule + StreamLiveInput CRDs; wasm-component build (CLI) ([#15](https://github.com/mizchi/k1c/issues/15)) ([e6528fb](https://github.com/mizchi/k1c/commit/e6528fbf46b5eab7fdf0338d159d8c91adf853bc))


### Bug Fixes

* every example passes kubectl apply --dry-run=server; operator verified on kind ([8f3228c](https://github.com/mizchi/k1c/commit/8f3228c96a5f63a1e094c2207d7da55f71bdeb45))

## [0.9.0](https://github.com/mizchi/k1c/compare/v0.8.0...v0.9.0) (2026-05-09)


### ⚠ BREAKING CHANGES

* switch volume bindings to standard k8s CSI shape

### Features

* examples migrated to CSI volume shape; k1c export-crds ([bd8ac27](https://github.com/mizchi/k1c/commit/bd8ac27d640c0774e7e8fd66d911c1673efc8284))
* k1c operator — k8s controller wraps the same lower/plan/apply core ([767187a](https://github.com/mizchi/k1c/commit/767187aac940f1ff36c748d8b3c9b8cd63c56bcb))
* switch volume bindings to standard k8s CSI shape ([4237282](https://github.com/mizchi/k1c/commit/4237282d1c7bfc2ef5f96bec0f8337970b08ff03))

## [0.8.0](https://github.com/mizchi/k1c/compare/v0.7.0...v0.8.0) (2026-05-09)


### Features

* **cli:** add k1c explain to introspect manifest schemas ([d62e3d1](https://github.com/mizchi/k1c/commit/d62e3d14d5f872d44b25a8bfe4caa85598f667a8))
* **cli:** apply --validate-only and richer diff output ([38f3980](https://github.com/mizchi/k1c/commit/38f39801e14772dd6ce93c93b1b7c5b38c54872b))
* **cli:** kubeconfig-style context store for multi-account / multi-zone ([177438d](https://github.com/mizchi/k1c/commit/177438dd9bd382542197efd9b4a1505d0a6e0c4a))

## [0.7.0](https://github.com/mizchi/k1c/compare/v0.6.0...v0.7.0) (2026-05-09)


### Features

* add TelemetryStack CRD ([bd73e7b](https://github.com/mizchi/k1c/commit/bd73e7bb740d1f1b99d59f270cb0589731ce83b2))
* telemetry — annotation-driven Logpush + k1c telemetry command ([99d5bbe](https://github.com/mizchi/k1c/commit/99d5bbe1dac1bb26ba0defa5d95a447590ebfe90))
* TelemetryStack aggregator — generated Worker that fans out Logpush ([5046dee](https://github.com/mizchi/k1c/commit/5046dee825077351a9b4930cad5f36d650939b1c))

## [0.6.0](https://github.com/mizchi/k1c/compare/v0.5.0...v0.6.0) (2026-05-09)


### Features

* AccessApplication supports biso / saas / infrastructure types ([1f1ed16](https://github.com/mizchi/k1c/commit/1f1ed16124b357b5ec653acef5ca73a3a7614254))
* add EmailRoutingRule CRD ([eda594c](https://github.com/mizchi/k1c/commit/eda594cb8ca1021d8bfd9172ee2f7419dbccdb3d))
* add URIRewriteRule and ResponseHeaderRule CRDs ([f3f6220](https://github.com/mizchi/k1c/commit/f3f622010afd89e92643f2aee164bc0e409830da))
* add WAFManagedRuleset CRD (Cloudflare-managed rule groups) ([e55d5ad](https://github.com/mizchi/k1c/commit/e55d5ad818f88383c89421d523ac7b9cc679cd5c))
* **cli:** -f accepts stdin (-) and directories for helm/kustomize pipes ([b9b4c55](https://github.com/mizchi/k1c/commit/b9b4c550d4fab53522e0faf7806861917514a962))
* **cli:** add k1c logs and k1c port-forward (wrangler wrappers) ([448a709](https://github.com/mizchi/k1c/commit/448a709d397433fb58fe7cbbbe4dd9e20dc98934))
* detect Worker entrypoint content-only changes via equals override ([ba1f67a](https://github.com/mizchi/k1c/commit/ba1f67a9919fba25c96c28c47bc86731a0f7f22d))
* in-place SSL update for CustomHostname via customHostnames.edit ([e5e429f](https://github.com/mizchi/k1c/commit/e5e429f411830491acbbe382a790f0c8de3c99da))
* Service LoadBalancer can auto-emit a DNSRecord ([93e514d](https://github.com/mizchi/k1c/commit/93e514d1319bd206258a692905cfd89e9b5a8c58))

## [0.5.0](https://github.com/mizchi/k1c/compare/v0.4.0...v0.5.0) (2026-05-09)


### Features

* AccessApplication supports bookmark type ([c7fa100](https://github.com/mizchi/k1c/commit/c7fa100673b1c4e95f73c07434a5dbb1f257c659))
* AccessApplication supports ssh / vnc types in addition to self_hosted ([da340af](https://github.com/mizchi/k1c/commit/da340af3a3e506046973eacf546f45789153d119))
* add CacheRule CRD (zone-scoped cache_settings) ([1e2f6d0](https://github.com/mizchi/k1c/commit/1e2f6d0bc3bf1a5717df86330b3cbc367fc5ae9d))
* add standalone AccessPolicy CRD with ref support ([2031ffc](https://github.com/mizchi/k1c/commit/2031ffccdad4efc19f6051985a6c5df5f772be65))
* add TransformRule / WAFCustomRule / RateLimitRule CRDs ([805500f](https://github.com/mizchi/k1c/commit/805500fd39c7014c277355e97ed894ff2358108b))
* async polling layer + CustomHostname CRD ([78539c0](https://github.com/mizchi/k1c/commit/78539c07a6f4659dce2e11f566ad854aa951bd57))
* **cli:** add --quiet / -q to apply ([2bfc4b8](https://github.com/mizchi/k1c/commit/2bfc4b8614f67ba05b8c2c22e7b86b195e1cb4ee))


### Bug Fixes

* resolve cross-resource ID placeholders at plan + apply time ([ec1014b](https://github.com/mizchi/k1c/commit/ec1014b314e3e028a49bb62f2bae9528ef0f56bb))

## [0.4.0](https://github.com/mizchi/k1c/compare/v0.3.0...v0.4.0) (2026-05-09)


### Features

* bind Ingress wildcard hosts via Workers Routes ([5f9b422](https://github.com/mizchi/k1c/commit/5f9b422b4adba25d146d6728ff5bf38a46603f07))
* implement AccessApplication CRD (Zero Trust self-hosted) ([70092e9](https://github.com/mizchi/k1c/commit/70092e97f79a75226254aefaba2c0c430f029987))

## [0.3.0](https://github.com/mizchi/k1c/compare/v0.2.0...v0.3.0) (2026-05-09)


### Features

* add mtls_certificate and pipelines Worker bindings ([6ffcab1](https://github.com/mizchi/k1c/commit/6ffcab1e30bd960465186bb81e2685c85670a1b4))
* implement Ingress (networking.k8s.io/v1) ([1351116](https://github.com/mizchi/k1c/commit/13511169cb6ab90b4d0576d403c96d24c0323301))


### Bug Fixes

* **cli:** render provider errors instead of "[object Object]" ([38493ed](https://github.com/mizchi/k1c/commit/38493eda8e9f1e22d1e44e485d20512e71e2d18f))
* order deletes by reverse type priority ([28e57c0](https://github.com/mizchi/k1c/commit/28e57c008a70b5b7d9979e8b6eb076e87868a62c))

## [0.2.0](https://github.com/mizchi/k1c/compare/v0.1.0...v0.2.0) (2026-05-09)


### Features

* --output=json, apply --watch, k1c version ([0e1e8f7](https://github.com/mizchi/k1c/commit/0e1e8f7106e51337fd67e7547466af302553f780))
* A-track features — content hash, Service→CustomDomain, get/describe/delete ([07a336e](https://github.com/mizchi/k1c/commit/07a336ea3464cd3b130198c939e36c9b37518174))
* AI/Browser/VersionMetadata/AnalyticsEngine bindings + LogpushJob CRD ([b15f298](https://github.com/mizchi/k1c/commit/b15f298716c2918efbc5e4bd26eb08be65fb29d6))
* CronJob + Service ClusterIP cross-Pod binding ([3524223](https://github.com/mizchi/k1c/commit/35242235c11acf6bf4232c14d2334cb62e46f12e))
* D1, Queue, StatefulSet → Durable Object — top-3 from the patterns survey ([6539707](https://github.com/mizchi/k1c/commit/65397077fa3a591e06db53080339e14f6a46b9c1))
* Hyperdrive CRD for Worker → private database connectivity ([7164bbf](https://github.com/mizchi/k1c/commit/7164bbf3b6b332a5e456abd234b3e2049f35b690))
* multi-container Pod → multiple Workers wired by service bindings ([38c4d95](https://github.com/mizchi/k1c/commit/38c4d95e443d83b23dbae1ddcbf760c4c6339023))
* npm publish setup ([497916c](https://github.com/mizchi/k1c/commit/497916c2482a50f56137f324b1d6ed9453ee4e5d))
* Vectorize, DNSRecord, Job → Workflow ([a6f62b4](https://github.com/mizchi/k1c/commit/a6f62b42630b134f62f55805efd65e9c75ac7a8c))
