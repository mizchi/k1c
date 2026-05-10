# Multi-tenant from external data

Generates per-tenant Cloudflare resources from a JSON list. Add a row to
`tenants.json`, re-evaluate, get N more buckets / KV namespaces / Workers.

```
examples/pkl/multi-tenant/
├── tenants.json   # data: edit this when onboarding/offboarding tenants
├── tenants.pkl    # logic: never edit this when a tenant changes
└── README.md
```

## Apply

```sh
k1c apply -f examples/pkl/multi-tenant/tenants.pkl --validate-only
# (validate-only: 12 resources lowered cleanly)

k1c apply -f examples/pkl/multi-tenant/tenants.pkl   # for real
```

## What it shows

### 1. External data via `read("…")`

```pkl
import "pkl:json"

local tenantsJson = new json.Parser {}.parse(read("tenants.json").text)
local tenants: List<Tenant> = tenantsJson.tenants.toList().map((t) -> new Tenant {
  name = t.name
  tier = t.tier
  region = t.region
})
```

`read()` returns a `Resource`; `.text` gives the raw string for the JSON
parser. Re-mapping the parsed `Dynamic` into our typed `Tenant` class
gives full type-checking on every downstream use.

If you put `t["name"]` instead of `t.name`, you get
`Cannot find key "name"` — `Dynamic` from `JsonParser` only exposes
property-style access.

### 2. `for` comprehension inside a `Listing`

```pkl
volumeMounts = new {
  for (t in tenants) {
    new k1c.VolumeMount {
      name = "tenant-\(t.name)"
      mountPath = "/mnt/tenants/\(t.name)"
    }
  }
}
```

The router Worker mounts every tenant's R2 bucket. Add a tenant to
`tenants.json` → router gains a new mount + binding without code change.

### 3. `.flatMap` for varying-cardinality output

```pkl
local perTenantData = tenants.flatMap((t) -> List(
  new k1c.R2Bucket  { metadata { name = bucketName(t) } ; spec { location = t.region } },
  new k1c.KVNamespace { metadata { name = kvName(t) } }
))
```

Two resources per tenant. `flatMap` keeps the result a flat `List`,
ready to concatenate with `perTenantWorkers + List(routerWorker)`.

### 4. `.filter` for tier-based gating

```pkl
local perTenantWorkers = tenants
  .filter((t) -> t.tier != "free")
  .map((t) -> new k1c.Deployment { … })
```

Free-tier tenants don't get a dedicated Worker — they ride the shared
router instead. The cost trade-off lives in code, not in a runbook.

## Output shape (4 tenants → 12 docs)

| count | kind          | source                            |
|-------|---------------|-----------------------------------|
| 4     | `R2Bucket`    | one per tenant                    |
| 4     | `KVNamespace` | one per tenant                    |
| 3     | `Deployment`  | one per non-free tenant           |
| 1     | `Deployment`  | shared router (mounts all R2s)    |

Free-tier (`initech`) deliberately has no dedicated Deployment.

## Idiom checklist when adapting this

- Always pull `read(...).text` before passing into `JsonParser.parse`.
- Use `t.field`, not `t["field"]`, on `JsonParser` output.
- Re-map dynamic input into a typed class (here: `Tenant`) at the
  boundary so the rest of the file is type-checked.
- For varying numbers of resources, prefer `flatMap` over building
  multiple `Listing`s and concatenating them; the result types stay
  uniform.
