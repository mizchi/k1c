# Changelog

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
