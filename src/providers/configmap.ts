import { z } from 'zod';
import type {
  CloudflareResourceProvider,
  CreateResult,
  DeleteResult,
  ListedResource,
  ProviderContext,
  UpdateResult,
} from './types.ts';
import { NotFound } from './types.ts';

// ConfigMap has no Cloudflare-side resource of its own.
// Its data is folded into Worker `vars` at apply time by the reconciler.
// This provider exists so the diff/list path can still reason about ConfigMap
// presence and content; reads/writes are local to the manifest graph.

export interface ConfigMapProperties {
  readonly data: Readonly<Record<string, string>>;
}

export const configMapSchema: z.ZodType<ConfigMapProperties> = z.object({
  data: z.record(z.string()),
});

export const configMapProvider: CloudflareResourceProvider<ConfigMapProperties> = {
  resourceType: 'ConfigMap',
  schema: configMapSchema,

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // ConfigMap is virtual: its presence is derived from referenced Workers.
    return;
  },

  async read(
    _ctx: ProviderContext,
    _nativeId: string,
  ): Promise<ConfigMapProperties | NotFound> {
    // Read is satisfied from the resource graph in the reconciler, not from CF API.
    throw new Error('configMapProvider.read should be served by the reconciler graph, not invoked directly');
  },

  async create(
    _ctx: ProviderContext,
    _label: string,
    _desired: ConfigMapProperties,
  ): Promise<CreateResult> {
    // No-op: writing the values happens during Worker create.
    return { kind: 'sync', nativeId: _label, properties: _desired };
  },

  async update(
    _ctx: ProviderContext,
    _nativeId: string,
    _prior: ConfigMapProperties,
    _desired: ConfigMapProperties,
  ): Promise<UpdateResult> {
    // Update is realized by re-applying referenced Workers; the Worker provider picks up new vars.
    return { kind: 'noop' };
  },

  async delete(_ctx: ProviderContext, _nativeId: string): Promise<DeleteResult> {
    return { kind: 'sync' };
  },
};
