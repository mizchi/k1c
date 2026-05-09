import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseManifest } from './manifest/parse.ts';
import { lower } from './manifest/lower.ts';

/**
 * Walk `examples/` and assert that every standalone YAML manifest there
 * parses + lowers without throwing. Catches regressions in the example
 * library when the schemas evolve. Files inside `helm-chart/templates/`
 * are skipped (they are Go-template input, not raw YAML), as is the
 * kustomize tree (the base files individually are valid manifests
 * but the kustomization.yaml itself is not a k1c resource).
 */

const EXAMPLES_DIR = new URL('../examples', import.meta.url).pathname;

const SKIP = new Set([
  // Helm chart templates contain {{ ... }} which is not valid YAML on its own.
  'helm-chart',
  // Kustomize manifests reference base/overlay structure, not k1c resources.
  'kustomize',
]);

const stubReadFile = async (p: string): Promise<Uint8Array> =>
  new TextEncoder().encode(`// stub for ${p}`);

async function listYamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) continue;
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    out.push(full);
  }
  return out;
}

describe('examples/ manifests parse + lower cleanly', async () => {
  const files = await listYamlFiles(EXAMPLES_DIR);
  // Sanity: there should be a non-trivial number of examples by now.
  it('finds at least 10 example manifests', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    const name = file.slice(EXAMPLES_DIR.length + 1);
    it(`${name}: parseManifest + lower succeed`, async () => {
      const text = (await readFile(file)).toString('utf-8');
      const parsed = parseManifest(text);
      expect(parsed.resources.length).toBeGreaterThan(0);
      const result = await lower(parsed.resources, { readFile: stubReadFile });
      expect(result.desired.length).toBeGreaterThan(0);
    });
  }
});
