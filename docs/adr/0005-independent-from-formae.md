# ADR-0005: Independent from formae; use as architectural reference only

- Status: Accepted
- Date: 2026-05-08

## Context

[formae](https://github.com/platform-engineering-labs/formae) is an IaC tool whose architectural choices closely match k1c: code-as-truth, no state files, drift detection by querying live infrastructure, plugin-based providers. It is also active and credible (Go, ~700 stars at time of writing, 6 months old).

Three integration paths were considered:

1. **Adopt formae.** Build k1c as a Cloudflare provider plugin for formae.
2. **Hybrid.** Translate k8s manifests into formae's Pkl input language; let formae handle reconciliation.
3. **Independent.** Implement our own reconciler; treat formae as architectural prior art.

## Decision

Adopt **Independent** (option 3).

formae is not a dependency. We may study its source for design ideas (and we do — see ADR-0006), but we ship our own reconciler and our own provider implementations.

## Reasoning

Three concrete blockers:

- **License.** formae is under FSL-1.1-ALv2 (Functional Source License). It converts to Apache-2.0 after two years, but until then it forbids competing commercial use and is not OSI-approved. Making formae a core dependency commits k1c to those terms transitively and leaves us exposed to upstream policy changes.
- **Input format mismatch.** formae expects Pkl. k1c expects Kubernetes YAML. Adopting formae means either (a) replacing our input format with Pkl and abandoning the entire premise of ADR-0001, or (b) writing a YAML→Pkl translator on top of formae, which is a second abstraction layer with no semantic gain.
- **Scope mismatch.** formae targets multi-cloud platform engineering. k1c is intentionally Cloudflare-only and intentionally Kubernetes-shaped. The Cloudflare-deep mapping we need (Workers Versions, Gradual Deployments, Service Bindings, Durable Object classes) is unlikely to flow through a generic plugin contract designed for AWS/Azure/GCP parity.

## Consequences

- We pay the implementation cost of building our own reconciler and CRUD providers. ADR-0004 and ADR-0006 absorb this.
- We are free of FSL constraints. k1c can adopt any license (Apache-2.0 or MIT expected).
- We can borrow formae's design ideas without inheriting its source. formae itself borrows from AWS CloudControl, which is well-documented and license-clean to imitate.

## Alternatives considered

- **Adopt formae as plugin host.** Rejected — license, input mismatch, scope mismatch.
- **Hybrid YAML→Pkl translator on top of formae.** Rejected — two abstraction layers, no semantic gain, license still applies.

## What we deliberately copy from formae

These are observations, not dependencies:

- The CRUD + Status + List + Discovery provider interface (see ADR-0006).
- The split of `NativeID` (cloud-side identifier) from `Label` (manifest-side identifier).
- The classification of error codes into `recoverable` vs `terminal`.
- The "live `Read` instead of stored prior state" approach to update diffs.
