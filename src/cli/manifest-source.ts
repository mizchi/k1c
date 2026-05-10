import { spawn } from 'node:child_process';
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
 *   `<file.pkl>`  a [PKL](https://pkl-lang.org) module — `pkl eval --format
 *                 yaml` is invoked transparently. The module is expected to
 *                 emit a multi-doc YAML stream (`output.renderer = new
 *                 YamlRenderer { isStream = true }`) so each k1c resource
 *                 lands as its own document.
 *   `<file>`      a single file, treated as YAML even without an extension.
 *
 * The point is to let users hand k1c whatever the rest of the k8s ecosystem
 * spits out — `helm template`, `kustomize build`, a `.pkl` module, a
 * directory of static manifests — without needing per-tool integration in
 * k1c itself.
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
  if (extname(source).toLowerCase() === '.pkl') {
    return evalPkl(source);
  }
  const buf = await readFile(source);
  return buf.toString('utf-8');
}

/**
 * Shell out to `pkl eval --format yaml <file>` and return the stdout.
 * Errors from pkl (parse failures, missing imports, type mismatches)
 * are surfaced verbatim so the user sees pkl's line/column diagnostics.
 */
function evalPkl(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pkl', ['eval', '--format', 'yaml', source]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      reject(
        new Error(
          `failed to invoke pkl: ${err.message}. Install pkl from https://pkl-lang.org/main/current/pkl-cli/index.html or use \`pkl eval --format yaml <file> | k1c apply -f -\` instead.`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`pkl eval ${source} failed (exit ${code}):\n${stderr}`));
      }
    });
  });
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
