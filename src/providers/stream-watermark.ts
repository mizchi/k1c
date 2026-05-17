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

export type StreamWatermarkPosition = 'upperRight' | 'upperLeft' | 'lowerLeft' | 'lowerRight' | 'center';

/**
 * Cloudflare Stream watermark profile. The image bytes are uploaded at
 * create time; subsequent updates regenerate the profile (no in-place
 * mutate on the Cloudflare side), so we throw NotUpdatable to signal
 * recreate.
 *
 * \`filePath\` is read off the local filesystem via ctx.readFile (or the
 * fs/promises default). The k1c-managed name prefix on the \`name\`
 * field is what makes list() able to identify rows.
 */
export interface StreamWatermarkProperties {
  /** Display name — k1c-prefixed so list() can identify managed rows. */
  readonly profileName: string;
  /** Path to the image file (relative to the manifest's cwd). */
  readonly filePath: string;
  readonly opacity?: number;
  readonly padding?: number;
  readonly position?: StreamWatermarkPosition;
  readonly scale?: number;
}

export const streamWatermarkPropertiesSchema: z.ZodType<StreamWatermarkProperties> = z.object({
  profileName: z.string(),
  filePath: z.string(),
  opacity: z.number().min(0).max(1).optional(),
  padding: z.number().min(0).max(1).optional(),
  position: z.enum(['upperRight', 'upperLeft', 'lowerLeft', 'lowerRight', 'center']).optional(),
  scale: z.number().min(0).max(1).optional(),
});

function normalize(p: StreamWatermarkProperties): unknown {
  // filePath is local-only; the Cloudflare side carries the rendered
  // image, so equality compares the tunables only.
  return {
    profileName: p.profileName,
    opacity: p.opacity ?? 1,
    padding: p.padding ?? 0.05,
    position: p.position ?? 'upperRight',
    scale: p.scale ?? 0.15,
  };
}

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const streamWatermarkProvider: CloudflareResourceProvider<StreamWatermarkProperties> = {
  resourceType: 'StreamWatermark',
  schema: streamWatermarkPropertiesSchema,
  equals: makeEquals<StreamWatermarkProperties>(normalize),

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    try {
      const page = await ctx.cloudflare.stream.watermarks.list({ account_id: ctx.accountId });
      for await (const w of page) {
        const label = parseLabel((w as { name?: string }).name);
        if (label === null) continue;
        const uid = (w as { uid?: string }).uid;
        if (typeof uid !== 'string') continue;
        yield { nativeId: uid, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const w = (await ctx.cloudflare.stream.watermarks.get(nativeId, {
        account_id: ctx.accountId,
      })) as {
        name?: string;
        opacity?: number;
        padding?: number;
        position?: string;
        scale?: number;
      };
      return {
        profileName: w.name ?? '',
        filePath: '',
        ...(w.opacity !== undefined ? { opacity: w.opacity } : {}),
        ...(w.padding !== undefined ? { padding: w.padding } : {}),
        ...(w.position !== undefined
          ? { position: w.position as StreamWatermarkPosition }
          : {}),
        ...(w.scale !== undefined ? { scale: w.scale } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    const bytes = await readFileBytes(ctx, desired.filePath);
    const file = new File([bytes], 'watermark.png', { type: 'image/png' });
    try {
      const w = (await ctx.cloudflare.stream.watermarks.create({
        account_id: ctx.accountId,
        file: file as unknown as string,
        ...(desired.profileName !== undefined ? { name: desired.profileName } : {}),
        ...(desired.opacity !== undefined ? { opacity: desired.opacity } : {}),
        ...(desired.padding !== undefined ? { padding: desired.padding } : {}),
        ...(desired.position !== undefined ? { position: desired.position } : {}),
        ...(desired.scale !== undefined ? { scale: desired.scale } : {}),
      })) as { uid?: string };
      const uid = w.uid ?? '';
      if (!uid) {
        throw {
          code: 'ServiceInternalError' as const,
          recoverable: false,
          message: 'Stream watermark create returned no uid',
        };
      }
      return { kind: 'sync', nativeId: uid, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(_ctx, _nativeId, _prior, _desired): Promise<UpdateResult> {
    // Cloudflare watermarks are immutable once created — the only
    // mutating endpoint is create, which always returns a new uid.
    throw {
      code: 'NotUpdatable',
      recoverable: false,
      suggest: 'recreate' as const,
      message:
        'StreamWatermark profiles are immutable; re-apply will not edit the existing profile.',
    };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.stream.watermarks.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};

async function readFileBytes(ctx: ProviderContext, path: string): Promise<Uint8Array> {
  const reader =
    ctx.readFile ??
    (async (p: string) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(p);
    });
  return reader(path);
}
