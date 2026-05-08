/**
 * Generates the JavaScript source for a k1c dispatcher Worker.
 *
 * The dispatcher reads canary state from a bound KV namespace and routes each request
 * to either the stable or canary script in a Workers for Platforms dispatch namespace.
 * State schema and routing logic are documented in ADR-0007.
 */

export interface DispatcherTemplateOptions {
  /** KV key under which the per-rollout state JSON is stored. */
  readonly rolloutKey: string;
  /** Script name of the stable variant inside the dispatch namespace. */
  readonly stableName: string;
  /** Script name of the canary variant inside the dispatch namespace. */
  readonly canaryName: string;
}

export function generateDispatcher(opts: DispatcherTemplateOptions): string {
  const ROLLOUT_KEY = JSON.stringify(opts.rolloutKey);
  const STABLE_NAME = JSON.stringify(opts.stableName);
  const CANARY_NAME = JSON.stringify(opts.canaryName);
  return `// k1c dispatcher (generated)
// rolloutKey=${opts.rolloutKey}
const ROLLOUT_KEY = ${ROLLOUT_KEY};
const STABLE_NAME = ${STABLE_NAME};
const CANARY_NAME = ${CANARY_NAME};

export default {
  async fetch(request, env) {
    const target = await pickTarget(env);
    return env.NAMESPACE.get(target).fetch(request);
  },
};

async function pickTarget(env) {
  const raw = await env.STATE.get(ROLLOUT_KEY);
  if (!raw) return STABLE_NAME;
  let state;
  try {
    state = JSON.parse(raw);
  } catch (_e) {
    return STABLE_NAME;
  }
  if (!state || state.status === 'idle' || !state.canaryScript) return STABLE_NAME;
  const w = typeof state.weight === 'number' ? state.weight : 0;
  if (w <= 0) return STABLE_NAME;
  if (w >= 100) return CANARY_NAME;
  return Math.random() * 100 < w ? CANARY_NAME : STABLE_NAME;
}
`;
}
