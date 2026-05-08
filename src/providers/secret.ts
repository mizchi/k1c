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

// Secret behaves like ConfigMap at the manifest layer, but its values are uploaded
// to Workers via the secrets endpoint (write-only, never returned by Read).
// The Worker provider performs the actual upload as part of the Worker apply.

export interface SecretProperties {
  // Values present locally; once applied, they are write-only on the Cloudflare side.
  readonly stringData: Readonly<Record<string, string>>;
}

export const secretSchema: z.ZodType<SecretProperties> = z.object({
  stringData: z.record(z.string()),
});

export const secretProvider: CloudflareResourceProvider<SecretProperties> = {
  resourceType: 'Secret',
  schema: secretSchema,

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Secrets are always inferred from referenced Workers and from the manifest itself.
    return;
  },

  async read(
    _ctx: ProviderContext,
    _nativeId: string,
  ): Promise<SecretProperties | NotFound> {
    // Cloudflare returns secret names but never values. We rely on the manifest as the
    // source of value truth; drift detection is hash-based via k1c.io/last-applied.
    throw new Error('secretProvider.read should be served by the reconciler graph, not invoked directly');
  },

  async create(
    _ctx: ProviderContext,
    _label: string,
    _desired: SecretProperties,
  ): Promise<CreateResult> {
    // Actual upload happens in the Worker provider; this records intent only.
    return { kind: 'sync', nativeId: _label, properties: { keys: Object.keys(_desired.stringData) } };
  },

  async update(
    _ctx: ProviderContext,
    _nativeId: string,
    _prior: SecretProperties,
    _desired: SecretProperties,
  ): Promise<UpdateResult> {
    return { kind: 'noop' };
  },

  async delete(_ctx: ProviderContext, _nativeId: string): Promise<DeleteResult> {
    // Secret deletion is realised by the Worker provider when the binding is removed.
    return { kind: 'sync' };
  },
};
