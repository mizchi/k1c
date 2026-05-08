import type { ZodSchema } from 'zod';
import type {
  CloudflareResourceProvider,
  CreateResult,
  DeleteResult,
  ListedResource,
  ProviderContext,
  ProviderError,
  StatusResult,
  UpdateResult,
} from '../providers/types.ts';
import { NotFound } from '../providers/types.ts';

// Fake provider for reconciler tests. Implements CloudflareResourceProvider with
// in-memory state. Records every CRUD call as an event, supports failure injection.

export type FakeEvent =
  | { readonly op: 'create'; readonly nativeId: string; readonly label: string; readonly properties: unknown }
  | { readonly op: 'update'; readonly nativeId: string; readonly properties: unknown }
  | { readonly op: 'delete'; readonly nativeId: string }
  | { readonly op: 'read'; readonly nativeId: string }
  | { readonly op: 'list' };

export interface FakeFailure {
  readonly op: 'create' | 'update' | 'delete' | 'read';
  remaining: number;
  readonly error: ProviderError;
}

export class FakeProvider<P> implements CloudflareResourceProvider<P> {
  readonly state = new Map<string, { label: string; properties: P }>();
  readonly events: FakeEvent[] = [];
  readonly failures: FakeFailure[] = [];
  #idCounter = 0;

  constructor(
    readonly resourceType: string,
    readonly schema: ZodSchema<P>,
  ) {}

  seed(nativeId: string, label: string, properties: P): void {
    this.state.set(nativeId, { label, properties });
  }

  injectFailure(failure: FakeFailure): void {
    this.failures.push(failure);
  }

  #consumeFailure(op: FakeFailure['op']): ProviderError | undefined {
    const f = this.failures.find((x) => x.op === op && x.remaining > 0);
    if (!f) return undefined;
    f.remaining -= 1;
    return f.error;
  }

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    this.events.push({ op: 'list' });
    for (const [nativeId, { label }] of this.state) {
      yield { nativeId, label };
    }
  }

  async read(_ctx: ProviderContext, nativeId: string): Promise<P | NotFound> {
    this.events.push({ op: 'read', nativeId });
    const err = this.#consumeFailure('read');
    if (err) throw err;
    const entry = this.state.get(nativeId);
    if (!entry) return NotFound;
    return entry.properties;
  }

  async create(_ctx: ProviderContext, label: string, desired: P): Promise<CreateResult> {
    const err = this.#consumeFailure('create');
    if (err) throw err;
    const nativeId = `native-${this.resourceType}-${++this.#idCounter}`;
    this.state.set(nativeId, { label, properties: desired });
    this.events.push({ op: 'create', nativeId, label, properties: desired });
    return { kind: 'sync', nativeId, properties: desired };
  }

  async update(
    _ctx: ProviderContext,
    nativeId: string,
    _prior: P,
    desired: P,
  ): Promise<UpdateResult> {
    const err = this.#consumeFailure('update');
    if (err) throw err;
    const entry = this.state.get(nativeId);
    const label = entry ? entry.label : 'unknown';
    this.state.set(nativeId, { label, properties: desired });
    this.events.push({ op: 'update', nativeId, properties: desired });
    return { kind: 'sync', nativeId, properties: desired };
  }

  async delete(_ctx: ProviderContext, nativeId: string): Promise<DeleteResult> {
    const err = this.#consumeFailure('delete');
    if (err) throw err;
    this.state.delete(nativeId);
    this.events.push({ op: 'delete', nativeId });
    return { kind: 'sync' };
  }

  async status(
    _ctx: ProviderContext,
    _nativeId: string,
    _opId: string,
  ): Promise<StatusResult> {
    return { kind: 'success', properties: null };
  }
}

export function makeFakeContext(): ProviderContext {
  return {
    cloudflare: {} as never,
    accountId: 'test-account',
    namespace: 'default',
    managedByLabel: 'k1c.io/managed-by=k1c',
    signal: new AbortController().signal,
    readFile: async (path: string) => new TextEncoder().encode(`// stub for ${path}`),
  };
}
