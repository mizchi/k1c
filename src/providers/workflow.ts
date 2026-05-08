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

export interface WorkflowProperties {
  readonly workflowName: string;
  readonly className: string;
  readonly scriptName: string;
}

export const workflowPropsSchema: z.ZodType<WorkflowProperties> = z.object({
  workflowName: z.string(),
  className: z.string(),
  scriptName: z.string(),
});

const NAME_PREFIX = 'k1c-';

function parseLabel(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  return `${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
}

export const workflowProvider: CloudflareResourceProvider<WorkflowProperties> = {
  resourceType: 'Workflow',
  schema: workflowPropsSchema,

  async *list(ctx: ProviderContext): AsyncIterable<ListedResource> {
    let iter;
    try {
      iter = ctx.cloudflare.workflows.list({ account_id: ctx.accountId });
    } catch (raw) {
      throw toProviderError(raw);
    }
    try {
      for await (const wf of iter) {
        const name = (wf as { name?: string }).name;
        if (!name) continue;
        const label = parseLabel(name);
        if (label === null) continue;
        // Workflows are addressed by name, not by a separate id.
        yield { nativeId: name, label };
      }
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async read(ctx, nativeId) {
    try {
      const wf = await ctx.cloudflare.workflows.get(nativeId, { account_id: ctx.accountId });
      const w = wf as {
        name?: string;
        class_name?: string;
        script_name?: string;
      };
      if (!w.name || !w.class_name || !w.script_name) return NotFound;
      return {
        workflowName: w.name,
        className: w.class_name,
        scriptName: w.script_name,
      };
    } catch (raw) {
      const err = toProviderError(raw);
      if (err.code === 'NotFound') return NotFound;
      throw err;
    }
  },

  async create(ctx, _label, desired): Promise<CreateResult> {
    // Cloudflare's Workflow registration uses PUT (the `update` method) for both
    // create and update — there is no separate POST endpoint.
    try {
      await ctx.cloudflare.workflows.update(desired.workflowName, {
        account_id: ctx.accountId,
        class_name: desired.className,
        script_name: desired.scriptName,
      });
      return { kind: 'sync', nativeId: desired.workflowName, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async update(ctx, nativeId, _prior, desired): Promise<UpdateResult> {
    try {
      await ctx.cloudflare.workflows.update(nativeId, {
        account_id: ctx.accountId,
        class_name: desired.className,
        script_name: desired.scriptName,
      });
      return { kind: 'sync', nativeId, properties: desired };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },

  async delete(ctx, nativeId): Promise<DeleteResult> {
    try {
      await ctx.cloudflare.workflows.delete(nativeId, { account_id: ctx.accountId });
      return { kind: 'sync' };
    } catch (raw) {
      throw toProviderError(raw);
    }
  },
};
