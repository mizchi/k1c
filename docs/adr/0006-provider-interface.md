# ADR-0006: Provider interface modeled after formae / AWS CloudControl

- Status: Accepted
- Date: 2026-05-08

## Context

The reconciler (ADR-0004) needs a uniform interface to call across heterogeneous Cloudflare resources (Workers, Routes, R2 Buckets, KV Namespaces, DNS records, Custom Hostnames, Durable Object classes, Cron Triggers, Queues). Each resource type has different REST endpoints, different identifier shapes, and different async characteristics.

We surveyed three reference designs:

- **AWS CloudControl API** — uniform `Create / Read / Update / Delete / List` with async progress via a `Status` poll. Property bags are opaque JSON validated by per-type schema.
- **formae's `ResourcePlugin`** — adds `RateLimit`, `DiscoveryFilters`, `LabelConfig` to the AWS CloudControl shape, plus async `Status`. formae itself is a generalization of CloudControl.
- **Pulumi / Terraform provider** — declarative resource graph, schema-driven, but tightly bound to their state-file lifecycle (ADR-0004 already rejected this).

## Decision

The k1c provider interface is an explicit imitation of formae's `ResourcePlugin`, simplified for our single-cloud, single-process context.

```typescript
export interface CloudflareResourceProvider<P> {
  readonly resourceType: string;     // e.g. "Worker", "R2Bucket"
  readonly schema: ZodSchema<P>;     // validates manifest properties

  list(ctx: ProviderContext): AsyncIterable<{ nativeId: string; label: string }>;
  read(ctx: ProviderContext, nativeId: string): Promise<P | NotFound>;

  create(ctx: ProviderContext, label: string, desired: P): Promise<CreateResult>;
  update(ctx: ProviderContext, nativeId: string, prior: P, desired: P): Promise<UpdateResult>;
  delete(ctx: ProviderContext, nativeId: string): Promise<DeleteResult>;

  status?(ctx: ProviderContext, nativeId: string, opId: string): Promise<StatusResult>;
}

interface ProviderContext {
  cloudflare: Cloudflare;            // official SDK client
  accountId: string;
  zoneId?: string;
  namespace: string;                 // k8s namespace
  managedByLabel: string;            // ownership marker, e.g. "k1c.io/managed-by=true"
  signal: AbortSignal;
}

type CreateResult =
  | { kind: 'sync';  nativeId: string; properties: unknown }
  | { kind: 'async'; nativeId: string; opId: string };

type UpdateResult = CreateResult | { kind: 'noop' };
type DeleteResult = { kind: 'sync' } | { kind: 'async'; opId: string };

export type ProviderError =
  | { code: 'Throttling';      recoverable: true  }
  | { code: 'NotStabilized';   recoverable: true  }
  | { code: 'NetworkFailure';  recoverable: true  }
  | { code: 'AccessDenied';    recoverable: false }
  | { code: 'NotUpdatable';    recoverable: false; suggest: 'recreate' }
  | { code: 'AlreadyExists';   recoverable: false }
  | { code: 'NotFound';        recoverable: false; suggest: 'recreate' };
```

### What we keep from formae

- **Six core methods** (`list`, `read`, `create`, `update`, `delete`, `status`).
- **`NativeID` vs `Label` split.** `NativeID` is Cloudflare's identifier (Worker script id, R2 bucket name, DNS record id). `Label` is the user's manifest-side identifier (`metadata.namespace/metadata.name`).
- **Live `read` for prior state.** `update` receives `prior` and `desired`. The reconciler obtains `prior` by calling `read` immediately before `update`, not from a state file.
- **Recoverable vs terminal error classification** with retry policy keyed off `recoverable: true`.
- **Async path via `status` polling** for resources that do not complete synchronously (Custom Hostname SSL provisioning, large R2 lifecycle changes).

### What we drop from formae

- **Actor model (`ergo`).** formae runs each plugin as a supervised actor. k1c ships in one process; plain TypeScript classes are sufficient.
- **Pkl-based plugin manifests (`formae-plugin.pkl`).** k1c providers live in the same TypeScript module; a constant `resourceType` and a zod schema is enough.
- **Dynamic plugin loading.** All providers are statically registered at compile time. New resource types are added by writing a `CloudflareResourceProvider<P>` and importing it into the registry.
- **`RateLimit()` per-plugin config.** Replaced by a single global semaphore with Cloudflare's documented per-account rate limits as defaults.
- **`MinFormaeVersion` compatibility checks.** No version skew exists in a single-binary distribution.

## Consequences

- The reconciler core (`apply`, `diff`, `delete`) is provider-agnostic. Adding a new Cloudflare resource type is one new file: `providers/<resource>.ts`.
- Tests can mock at the provider level, not at the SDK level. Each provider's contract is small.
- We commit to the "live read before update" pattern. This costs one extra API call per update but eliminates a class of state-drift bugs.
- Async resources require correct `status` polling, including timeouts and back-off. The reconciler will provide this loop generically; providers only return `{ kind: 'async', opId }`.

## Alternatives considered

- **Pure CRUD without `list` and without `status`.** Rejected — without `list` we cannot detect deletions; without `status` we cannot wait on Custom Hostnames.
- **Schema in JSON Schema instead of zod.** Rejected for v0 — zod is a smaller, faster fit for TypeScript and produces identical validation for our needs. JSON Schema export is a follow-up if a non-TypeScript host wants to read provider schemas.
- **Provider per resource group instead of per resource type.** Rejected — coarser providers couple unrelated resources and complicate dependency ordering.
