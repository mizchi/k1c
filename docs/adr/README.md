# Architecture Decision Records

Decisions for **k1c**: a tool that applies a subset of Kubernetes manifests to Cloudflare.

| # | Title | Status |
|---|---|---|
| [0001](0001-project-goal.md) | Project goal: kubectl-style apply for Cloudflare | Accepted |
| [0002](0002-translator-over-control-plane.md) | Translator architecture over a control plane | Accepted |
| [0003](0003-manifest-dialect.md) | Manifest dialect: Argo Rollouts subset + annotations + minimal CRDs | Accepted |
| [0004](0004-stateless-reconciler.md) | Stateless reconciler against the Cloudflare API; no cdktf/pulumi | Accepted |
| [0005](0005-independent-from-formae.md) | Independent from formae; use as architectural reference only | Accepted |
| [0006](0006-provider-interface.md) | Provider interface modeled after formae / AWS CloudControl | Accepted |
| [0007](0007-canary-via-dynamic-dispatch.md) | Canary deployments via Workers for Platforms Dynamic Dispatch | Accepted |

## Conventions

- One file per decision, monotonically numbered.
- Status: `Proposed`, `Accepted`, `Superseded by NNNN`, `Deprecated`.
- Each ADR has: Context, Decision, Consequences, Alternatives considered.
- Supersede rather than rewrite. Old ADRs stay so the trail is readable.
