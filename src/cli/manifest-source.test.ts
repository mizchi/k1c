import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifestSource } from './manifest-source.ts';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'k1c-source-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('readManifestSource', () => {
  it('reads a single file as-is', async () => {
    const f = join(workdir, 'a.yaml');
    await writeFile(f, 'kind: Foo\nmetadata: { name: a }\n');
    expect(await readManifestSource(f)).toBe('kind: Foo\nmetadata: { name: a }\n');
  });

  it('concatenates every yaml/yml file in a directory with --- separators', async () => {
    await writeFile(join(workdir, 'b.yaml'), 'kind: B\n');
    await writeFile(join(workdir, 'a.yml'), 'kind: A\n');
    await writeFile(join(workdir, 'README.md'), '# not a manifest\n');
    const out = await readManifestSource(workdir);
    // Files are sorted lexicographically: a.yml before b.yaml.
    expect(out).toContain('kind: A');
    expect(out).toContain('kind: B');
    expect(out).toContain('---');
    expect(out.indexOf('kind: A')).toBeLessThan(out.indexOf('kind: B'));
    expect(out).not.toContain('not a manifest');
  });

  it('recurses into subdirectories', async () => {
    const sub = join(workdir, 'overlay');
    await mkdir(sub, { recursive: true });
    await writeFile(join(workdir, 'base.yaml'), 'kind: Base\n');
    await writeFile(join(sub, 'patch.yaml'), 'kind: Patch\n');
    const out = await readManifestSource(workdir);
    expect(out).toContain('kind: Base');
    expect(out).toContain('kind: Patch');
  });

  it('skips files starting with `_` (helm chart partials) and `.`', async () => {
    await writeFile(join(workdir, '_helpers.yaml'), 'kind: Partial\n');
    await writeFile(join(workdir, '.hidden.yaml'), 'kind: Hidden\n');
    await writeFile(join(workdir, 'real.yaml'), 'kind: Real\n');
    const out = await readManifestSource(workdir);
    expect(out).toContain('kind: Real');
    expect(out).not.toContain('kind: Partial');
    expect(out).not.toContain('kind: Hidden');
  });

  it('throws a clean error for missing paths', async () => {
    await expect(readManifestSource(join(workdir, 'nope.yaml'))).rejects.toThrow(
      /failed to read manifest source/,
    );
  });
});
