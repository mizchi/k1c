import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import process from 'node:process';

/**
 * Read manifest YAML from one of:
 *
 *   `-`           stdin (so `helm template ... | k1c apply -f -` works
 *                 and likewise `kustomize build ./overlays/prod | k1c apply -f -`)
 *   `<dir>`       every `.yaml` / `.yml` file under the directory, recursively,
 *                 concatenated in lexicographic order separated by `---`.
 *                 Files starting with `_` or `.` are skipped (helm chart
 *                 partials use `_` prefix; hidden files are skipped by
 *                 convention).
 *   `<file>`      a single file, treated as YAML even without an extension.
 *
 * The point is to let users hand k1c whatever the rest of the k8s ecosystem
 * spits out — `helm template`, `kustomize build`, a directory of static
 * manifests — without needing per-tool integration in k1c itself.
 */
export async function readManifestSource(source: string): Promise<string> {
  if (source === '-') {
    return readStdin();
  }
  let s;
  try {
    s = await stat(source);
  } catch (err) {
    throw new Error(`failed to read manifest source ${source}: ${(err as Error).message}`);
  }
  if (s.isDirectory()) {
    return readDirectory(source);
  }
  const buf = await readFile(source);
  return buf.toString('utf-8');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readDirectory(dir: string): Promise<string> {
  const files = await collectYamlFiles(dir);
  files.sort();
  const parts: string[] = [];
  for (const f of files) {
    const buf = await readFile(f);
    parts.push(buf.toString('utf-8'));
  }
  // Insert an explicit `---` between files so a file that does not end with a
  // separator does not bleed into the next file's first document.
  return parts.join('\n---\n');
}

async function collectYamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectYamlFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    out.push(full);
  }
  return out;
}
