# SaaS app: multi-environment PKL composition

A larger PKL example exercising composition / abstraction features:

```
saas/
├── _conventions.pkl    # naming + label helpers, region-per-env policy
├── _stack-web.pkl      # WebStack class — R2 bucket + KV + Worker
├── _stack-api.pkl      # ApiStack class — D1 + (optional) Queue + Worker
├── _environment.pkl    # base module: amends point + multi-doc YAML rendering
├── dev.pkl             # amends _environment, instantiates stacks for dev
└── prod.pkl            # same shape, prod parameters
```

## Apply

```sh
k1c apply -f examples/pkl/saas/dev.pkl  --dry-run    # 5 resources
k1c apply -f examples/pkl/saas/prod.pkl --dry-run    # 6 resources (adds Queue)
```

## What this exercises

- **Cross-file imports** with `import "_stack-web.pkl" as stackWeb`. PKL needs explicit aliasing for kebab-case files (the default identifier derived from the filename rejects dashes).
- **`amends` chain**: `dev.pkl` and `prod.pkl` amend `_environment.pkl` to inherit the YAML-stream rendering boilerplate, then override the `web` and `api` slots.
- **Per-environment branching** in pure data:
  - `_conventions.regionFor(env)` returns `weur` for prod, `enam` for staging, `wnam` for dev.
  - `_stack-web` derives `replicaCount` from `envName`.
  - `_stack-api` skips the Queue + its volume mount entirely on dev via `when (wantsQueue) { ... }`.
- **Stable naming**: `conventions.nameFor(envName, "web") == "prod-web"` keeps every related resource (R2 bucket, KV ns, Worker, label set) in lockstep without manual stringly-typed prefix juggling.
- **Multi-doc YAML output**: `output.renderer = new YamlRenderer { isStream = true }` paired with `value = web.resources + api.resources` (List concat) produces the multi-doc stream `k1c apply -f` expects.

## Gotcha: identifier shadowing

PKL resolves bare identifiers in the *narrowest* enclosing scope. The
following innocent-looking code stack-overflows:

```pkl
class WebStack {
  env: String                  // outer
  // ...
  resources = new Listing {
    new k1c.Container {
      name = "web"
      env { ... }              // inner — Listing<EnvVar> on Container
    }
  }
}
```

Inside `new k1c.Container { ... }`, the bare `env` resolves to the
container's `env` field, not the WebStack's `env` parameter. Same
trap with `name`, `replicas`, `labels`. The fix is to rename the
outer slot to something unambiguous (`envName`, `instanceName`,
`replicaCount`, `commonLabels`) — see how this example does it.

## Errors caught at edit time

```pkl
api = new stackApi.ApiStack {
  envName = "staging"   // OK — within the typealias
}

api = new stackApi.ApiStack {
  envName = "qa"        // FAIL: Expected "dev"|"staging"|"prod", got "qa"
}
```

PKL fails before `pkl eval` produces any YAML — meaning before
`k1c apply` makes any Cloudflare API call.
