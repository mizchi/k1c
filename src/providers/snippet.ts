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
import { toProviderError } from './errors.ts';
import { makeEquals } from './_equality.ts';

/**
 * Cloudflare Snippet — a lightweight per-zone edge script (5ms CPU
 * budget on the free plan, no bindings beyond `request`/`fetch`). Use
 * for redirects, header injection, AB-test slot picking — anything a
 * Worker would be overkill for.
 *
 * The snippet is keyed by (zoneId, snippetName); we store the join in
 * a `${zoneId}::${snippetName}` nativeId. Bodies are uploaded inline
 * via multipart; for now we support a single main module (`snippet.js`
 * by default) — if you need per-module split, drop down to wrangler.
 */
export interface SnippetProperties {
  readonly zoneId: string;
  readonly snippetName: string;
  /** Module file name registered in the metadata. */
  readonly mainModule: string;
  /** JavaScript source bytes. */
  readonly content: string;
}

export const snippetPropertiesSchema: z.ZodType<SnippetProperties> = z.object({
  zoneId: z.string(),
  snippetName: z.string(),
  mainModule: z.string(),
  content: z.string(),
});

function normalize(p: SnippetProperties): unknown {
  return p;
}

function splitNativeId(nativeId: string): { zoneId: string; snippetName: string } {
  const sep = nativeId.indexOf('::');
  if (sep <= 0) throw new Error(`malformed Snippet nativeId: ${nativeId}`);
  return { zoneId: nativeId.slice(0, sep), snippetName: nativeId.slice(sep + 2) };
}

export const snippetProvider: CloudflareResourceProvider<SnippetProperties> = {
  resourceType: 'Snippet',
  schema: snippetPropertiesSchema,
  equals: makeEquals<SnippetProperties>(normalize),

  async *list(_ctx: ProviderContext): AsyncIterable<ListedResource> {
    // Snippets are zone-scoped and a cluster-wide list would require
    // walking every zone; rely on read+diff on the known nativeId.
  },

  async read(ctx, nativeId) {
    const { zoneId, snippetName } = splitNativeId(nativeId);
    try {
      const s = await ctx.cloudflare.snippets.get(snippetName, { zone_id: zoneId });
      // Cloudflare doesn't return the script body on read, so the
      // content field stays empty and equality (via normalize above)
      // would always flag a "change". We trust the user to bump the
      // snippet only when the source actually changes; if drift
      // matters, lift content hashing into metadata.tags later.
      return {
        zoneId,
        snippetName: s.snippet_name ?? snippetName,
        mainModule: 'snippet.js',
        content: '',
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    await putSnippet(ctx, desired);
    return {
      kind: 'sync',
      nativeId: `${desired.zoneId}::${desired.snippetName}`,
      properties: desired,
    };
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    await putSnippet(ctx, desired);
    return { kind: 'sync', nativeId, properties: desired };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    const { zoneId, snippetName } = splitNativeId(nativeId);
    try {
      await ctx.cloudflare.snippets.delete(snippetName, { zone_id: zoneId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};

async function putSnippet(ctx: ProviderContext, desired: SnippetProperties): Promise<void> {
  const file = new File([desired.content], desired.mainModule, {
    type: 'application/javascript+module',
  });
  // Same trick as worker provider's upload: send metadata as a single
  // JSON-typed part rather than letting the SDK serializer flatten it
  // into `metadata[key]=value` fields, which the snippets endpoint
  // rejects.
  const metadataBlob = new File(
    [JSON.stringify({ main_module: desired.mainModule })],
    'metadata',
    { type: 'application/json' },
  );
  try {
    await ctx.cloudflare.snippets.update(
      desired.snippetName,
      {
        zone_id: desired.zoneId,
        metadata: metadataBlob,
        [desired.mainModule]: file,
      } as never,
    );
  } catch (raw) {
    throw toProviderError(raw);
  }
}
