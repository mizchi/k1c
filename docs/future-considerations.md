# Future considerations

Open design directions that have been discussed but not yet committed via ADR. Notes here are conversational, not normative.

## Cloudflare Workflows as a server-side runtime

[Cloudflare Workflows](https://www.cloudflare.com/developer-platform/products/workflows/) is a durable execution engine on Workers. Each step is checkpointed, supports configurable retry, can sleep for arbitrary durations, and survives Worker restarts.

The k1c reconciler is already structured around discrete operations (create / update / delete per resource), which maps cleanly to Workflow's `step.do(...)` boundaries:

```ts
class K1cApplyWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const desired  = await step.do('lower', () => lower(parseManifest(yaml).resources).desired);
    const planned  = await step.do('plan',  () => plan(desired, registry, ctx));
    for (const op of planned.operations) {
      await step.do(`${op.kind}:${op.label}`, () => runOperation(op, registry, ctx));
    }
  }
}
```

### Why this is interesting

- **Durable apply** — each operation checkpointed; mid-run failures resume from the failed step.
- **GitOps target** — webhook (GitHub push) → Workflow trigger; no developer machine in the loop.
- **Scheduled drift detection** — cron triggers can run `k1c diff` nightly and alert on drift.
- **Step-level UI** — Cloudflare's dashboard shows each operation's state, cleaner than CLI logs.
- **Stays Cloudflare-only** — consistent with ADR-0001's deliberate Cloudflare lock-in.

### Why we are not building it now

- v0 is fresh and fragile; adding a second runtime path would split focus before the first is e2e-tested.
- Manifest source becomes a design question (R2 / git pull / D1 / KV / HTTP body) — its own ADR.
- Auth model gets non-trivial (Workflow worker holds CF API tokens that manage its own account; multi-tenant gets harder still).
- Cost is small but non-zero; the CLI path stays free.

### Preconditions for revisiting

- v0 e2e tested against real Cloudflare.
- Async polling implemented (Workflow steps would benefit from this directly).
- Rough sketch of where manifests come from in the Workflow path.

When we revisit, write **ADR-0007 "Multiple runtime modes: CLI and Workflow"** first. The reconciler core is already runtime-agnostic (`plan` and `apply` are pure over registry + context), so the work is mostly:

1. A new `src/runtimes/workflow/` adapter wrapping `runOperation` in `step.do`.
2. Manifest source abstraction (R2 fetcher initially).
3. A `wrangler.toml`-shaped deploy story.

## Workers VPC (the unifying primitive — preview)

[Workers VPC](https://blog.cloudflare.com/workers-virtual-private-cloud/) was announced in 2025 as Cloudflare's unifying answer for "Workers needs to reach private resources, including AWS / GCP / on-prem". It comes in two pieces:

1. **Workers VPC** — groups Workers, R2, KV, and D1 into an isolated environment; only resources inside the same VPC can address each other.
2. **Workers VPC Private Link** — connects a Workers VPC to an external VPC (AWS / GCP / on-prem) via Tunnel, IPsec, or Network Interconnect.

The runtime contract stays fetch-binding shaped: `env.WORKERS_VPC_RESOURCE.fetch("/api/users/342")`. From the manifest layer this is the same as a `service` binding in spirit, just pointing at an external endpoint exposed through the VPC.

### Why this re-frames the earlier "VPC pieces" table

The Cloudflare blog explicitly calls out that:

- **Hyperdrive** is the **predecessor / point-to-point** version. Workers VPC generalizes its private-DB use case to any private API and to any cloud.
- **Cloudflare Tunnel** is one of the underlying transports (alongside IPsec and Network Interconnect) that Private Link reuses.
- **Magic WAN / Magic Cloud Networking** are the substrate Private Link is built on.

So the messy 4-row table that used to live here ("Tunnel deferred", "Magic WAN out of scope", etc.) collapses into one direction: **wait for Workers VPC, then ship a single `WorkersVPC` CRD that subsumes the lot**.

### What k1c does today vs what is deferred

| Capability | Today in k1c | After Workers VPC ships |
|---|---|---|
| Worker → Postgres / MySQL pool | `Hyperdrive` CRD (shipped, v0.2) | Stays as-is for the simple case; can also be modeled as a Workers VPC private endpoint. |
| Worker → arbitrary private HTTP API | not supported | `WorkersVPC` CRD + `volumes[].workersVpcRef` → `workers_vpc` Worker binding. |
| Worker → resource in AWS / GCP VPC | not supported | Same `WorkersVPC` CRD; Private Link config under `spec.privateLink`. |
| Worker → on-prem behind Tunnel | not supported | Same `WorkersVPC` CRD with the tunnel referenced in `spec.privateLink.tunnel`. |

### Status and decision

- Workers VPC is **early preview at the time of writing**. The cloudflare-typescript SDK 4.5 does not yet expose a `workers/vpc` resource (only `magic-network-monitoring/vpc-flows`, which is monitoring of someone else's VPC, unrelated).
- We do **not** ship a CRD stub now. Reasoning: a stub that fails at apply time is misleading in an experimental project, and the preview API may rename fields before GA. Hyperdrive covers the most common "Worker → private DB" case for free in the meantime.
- When the SDK adds `workers/vpc.*`, the implementation pattern is identical to Hyperdrive's: a `WorkersVPC` CRD, a provider with CRUD, a `workers_vpc` Worker binding kind, and `volumes[].workersVpcRef` plumbed through `buildContainerProperties`.

A short ADR (likely **ADR-0008 "Workers VPC integration"**) gets written at that point, with the deliberate decisions about `Tunnel` / `Hyperdrive` co-existence and the "should an existing `Hyperdrive` resource be auto-migrated into a Workers VPC member" question.

## Other deferred items (briefly)

- **Rollout v0.1.2** — implement `canary.steps` (state machine across multiple applies, traffic-split via `deployments.create` with two `version_id`s) and `blueGreen.autoPromotionEnabled=false` (separate `k1c rollout promote` command, deploys staged version at 0% then 100% on promote).
- **Worker.create on a fresh script** — assumes `scripts.versions.create` auto-creates the script. Needs verification against real Cloudflare; if it 404s, add a fallback to `scripts.update` for the first version.
- **Async polling via `status()`** — provider interface has the hook, reconciler is sync-only. Custom Hostname SSL provisioning will force this.
- **Reverse-topo on deletes** — current delete order is label-sorted. Cloudflare tolerates out-of-order deletes, but reverse-topo would be cleaner.
