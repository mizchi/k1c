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

export interface QueueProperties {
  readonly queueName: string;
  /** When set, k1c will register the named Worker as a consumer of this queue. */
  readonly consumerWorkerName?: string;
}

export const queuePropsSchema: z.ZodType<QueueProperties> = z.object({
  queueName: z.string(),
  consumerWorkerName: z.string().optional(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const queueProvider: CloudflareResourceProvider<QueueProperties> = {
  resourceType: 'Queue',
  schema: queuePropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.queues.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const q of iter) {
        const qName = (q as { queue_name?: string }).queue_name;
        const qId = (q as { queue_id?: string }).queue_id;
        if (!qName || !qId) continue;
        const label = parseLabel(qName);
        if (label === null) continue;
        yield { nativeId: qId, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const q = await ctx.cloudflare.queues.get(nativeId, { account_id: ctx.accountId });
      const obj = q as {
        queue_name?: string;
        consumers?: Array<{ script?: string; service?: string }>;
      };
      if (!obj.queue_name) return NotFound;
      // Pick the first Worker-style consumer if any. Multi-consumer queues are out of
      // scope for v0.2; the reconciler will overwrite with the manifest's intent.
      const consumer = (obj.consumers ?? []).find(
        (c) => typeof (c.script ?? c.service) === 'string',
      );
      const consumerWorkerName = consumer?.script ?? consumer?.service;
      return {
        queueName: obj.queue_name,
        ...(consumerWorkerName !== undefined ? { consumerWorkerName } : {}),
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    try {
      const q = await ctx.cloudflare.queues.create({
        account_id: ctx.accountId,
        queue_name: desired.queueName,
      });
      const id = (q as { queue_id?: string }).queue_id ?? desired.queueName;
      if (desired.consumerWorkerName !== undefined) {
        await registerConsumer(ctx, id, desired.consumerWorkerName);
      }
      return { kind: 'sync', nativeId: id, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, prior, desired): Promise<UpdateResult> {
    if (prior.queueName !== desired.queueName) {
      throw {
        code: 'NotUpdatable',
        recoverable: false,
        suggest: 'recreate' as const,
        message: 'Queue name is immutable; recreate to change.',
      };
    }
    if (prior.consumerWorkerName !== desired.consumerWorkerName) {
      try {
        // Cloudflare's queue consumer API supports multiple consumers; we treat the
        // manifest as authoritative and re-register. A more careful diff would
        // delete-then-create, but for v0.2 the upsert pattern is good enough.
        if (desired.consumerWorkerName !== undefined) {
          await registerConsumer(ctx, nativeId, desired.consumerWorkerName);
        }
      } catch (raw) {
        throw toProviderError(raw);
      }
    }
    return { kind: 'sync', nativeId, properties: desired };
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.queues.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};

async function registerConsumer(
  ctx: ProviderContext,
  queueId: string,
  workerName: string,
): Promise<void> {
  await ctx.cloudflare.queues.consumers.create(queueId, {
    account_id: ctx.accountId,
    type: 'worker',
    script_name: workerName,
  } as never);
}
