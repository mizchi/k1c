import { describe, it, expect } from 'vitest';
import { generateDispatcher } from './dispatcher-template.ts';

describe('generateDispatcher', () => {
  it('embeds the rollout key, stable name, and canary name as JSON literals', () => {
    const src = generateDispatcher({
      rolloutKey: 'rollout/default/api',
      stableName: 'k1c--default--api--stable',
      canaryName: 'k1c--default--api--canary',
    });
    expect(src).toContain('"rollout/default/api"');
    expect(src).toContain('"k1c--default--api--stable"');
    expect(src).toContain('"k1c--default--api--canary"');
  });

  it('exports a default fetch handler', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    expect(src).toMatch(/export default\s*\{/);
    expect(src).toMatch(/async fetch\s*\(request,\s*env\)/);
  });

  it('returns stable when state is missing', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    // Look for the early-return-on-missing-state branch.
    expect(src).toMatch(/if\s*\(!raw\)\s*return\s+STABLE_NAME/);
  });

  it('routes 100% to canary when weight >= 100', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    expect(src).toMatch(/if\s*\(w\s*>=\s*100\)\s*return\s+CANARY_NAME/);
  });

  it('uses Math.random for weighted routing in [0, 100)', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    expect(src).toMatch(/Math\.random\(\)\s*\*\s*100\s*<\s*w/);
  });

  it('safely handles JSON.parse failure (treats as stable)', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    expect(src).toMatch(/JSON\.parse/);
    expect(src).toMatch(/catch[\s\S]*?return\s+STABLE_NAME/);
  });

  it('escapes special characters in the rollout key', () => {
    const src = generateDispatcher({
      rolloutKey: 'rollout/default/with"quote',
      stableName: 's',
      canaryName: 'c',
    });
    // JSON.stringify must produce a valid JS string literal.
    expect(src).toContain('"rollout/default/with\\"quote"');
  });

  it('produces source that parses as ES module syntax', () => {
    const src = generateDispatcher({ rolloutKey: 'r', stableName: 's', canaryName: 'c' });
    // Quick sanity check via Function constructor — won't actually run, just parses.
    // Strip the export keyword which Function can't handle.
    const stripped = src.replace(/^export default\s*/m, 'const _x = ');
    expect(() => new Function(stripped)).not.toThrow();
  });
});
