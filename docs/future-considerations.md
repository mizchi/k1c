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

## Other deferred items (briefly)

- **Rollout v0.1.2** — implement `canary.steps` (state machine across multiple applies, traffic-split via `deployments.create` with two `version_id`s) and `blueGreen.autoPromotionEnabled=false` (separate `k1c rollout promote` command, deploys staged version at 0% then 100% on promote).
- **Worker.create on a fresh script** — assumes `scripts.versions.create` auto-creates the script. Needs verification against real Cloudflare; if it 404s, add a fallback to `scripts.update` for the first version.
- **Async polling via `status()`** — provider interface has the hook, reconciler is sync-only. Custom Hostname SSL provisioning will force this.
- **Worker entrypoint content hash** — manifest unchanged but JS file changed → currently no update is triggered. Fix: hash file content into Worker properties at lower time.
- **Reverse-topo on deletes** — current delete order is label-sorted. Cloudflare tolerates out-of-order deletes, but reverse-topo would be cleaner.
