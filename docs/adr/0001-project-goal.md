# ADR-0001: Project goal — kubectl-style apply for Cloudflare

- Status: Accepted
- Date: 2026-05-08

## Context

Kubernetes is the IaC model the author prefers, but the smallest managed control plane (GKE ~JPY 8,000/month) is not justifiable for personal projects. The author wants the same manifest format and `apply` UX across personal Cloudflare projects and company-scale Kubernetes clusters, without paying for two separate mental models.

Cloudflare provides a credible runtime for personal-scale workloads (Workers, Durable Objects, R2, KV, D1, Queues, Cron Triggers, Custom Domains). What is missing is a `kubectl apply -f` shaped UX over those primitives.

Existing options were considered and rejected for this purpose:

- **Wrangler** is per-Worker and does not generalize over R2/DNS/multi-Worker apps.
- **Pulumi / Terraform / CDKTF** are full IaC tools with their own state model. They do not accept Kubernetes manifests as input and they impose a separate state file.
- **SST / Alchemy** are Cloudflare-native but use TypeScript-specific DSLs, breaking portability with company Kubernetes manifests.
- **Real Kubernetes** (k3s, kind, GKE) does not run on Cloudflare's substrate.

## Decision

Build **k1c**: a CLI that

1. accepts a defined subset of Kubernetes manifests (YAML) as the user-facing input,
2. translates them into Cloudflare resources,
3. applies them through the Cloudflare API,
4. exposes a `kubectl`-like UX (`apply`, `get`, `delete`, `diff`).

The product positioning is "k1c for Kubernetes natives, Cloudflare-only" — not a portable multi-cloud IaC, not a general k8s replacement.

## Consequences

- **Lock-in to Cloudflare** is accepted as a deliberate design choice. The "portability" of k8s manifests across providers is a fiction we explicitly do not chase.
- **Subset of k8s** — only resources that have a credible Cloudflare mapping are supported. `DaemonSet`, `kubectl exec`, NodePort, NetworkPolicy and similar concepts are out of scope.
- **Same manifest, two backends** — manifests written for k1c should remain runnable on a real k8s cluster after stripping `cloudflare.com/*` annotations and any k1c-specific CRDs. This constraint guides every dialect choice (see ADR-0003).

## Alternatives considered

- **Build a "real" Cloudflare Workers control plane** with reconciliation loops on Durable Objects. Rejected: Workers cannot execute pods, so a control plane without a substrate is decorative. Discussed in ADR-0002.
- **Adopt Pulumi / Terraform with a thin manifest layer on top.** Rejected: see ADR-0004.
- **Fork formae and add a Cloudflare provider.** Rejected: see ADR-0005.
