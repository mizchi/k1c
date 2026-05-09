#!/usr/bin/env node
// Build a wasm-friendly bundle of the k1c CLI.
//
// Pipeline:
//   1. `tsc` (run via `pnpm build`) emits dist/cli/wasm-main.js plus
//      the rest of the JS sources.
//   2. esbuild bundles dist/cli/wasm-main.js + every transitive
//      runtime dep into a single ESM module at
//      `dist-wasm/k1c.bundle.mjs`. node:* imports are left external —
//      StarlingMonkey / componentize-js polyfill them.
//   3. (Optional) componentize-js wraps the bundle in a WASI 0.2
//      cli/run component at `dist-wasm/k1c.wasm`. This needs the
//      wasi-cli WIT files vendored under `wit/` (we ship a stub
//      world; the wasi-cli deps must be added by the user). Failures
//      here don't fail the build — the bundle is still emitted and
//      can be componentized out-of-band.
//
// The wasm target intentionally drops a few commands (operator, logs,
// port-forward, rollout, config, apply --watch) — see the file header
// in src/cli/wasm-main.ts for the full list and rationale.
//
// Usage:
//   pnpm build && pnpm build:wasm

import { build } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'dist-wasm');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function bundleEsm() {
  await mkdir(outDir, { recursive: true });
  const entry = path.join(distDir, 'cli', 'wasm-main.js');
  if (!(await exists(entry))) {
    console.error(
      `[build-wasm] ${entry} not found — run \`pnpm build\` first.`,
    );
    process.exit(1);
  }
  const result = await build({
    entryPoints: [entry],
    outfile: path.join(outDir, 'k1c.bundle.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    // StarlingMonkey shims node:* imports that are supported under
    // WASI 0.2; mark them external so esbuild leaves them alone and
    // componentize-js polyfills them at component-link time.
    external: [
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:url',
      'node:process',
      'node:buffer',
      'node:crypto',
      'node:os',
      'node:stream',
      'node:stream/web',
      'node:events',
      'node:util',
      'node:tty',
    ],
    legalComments: 'none',
    metafile: true,
    logLevel: 'info',
  });
  // Stash the metafile so we can sanity-check the bundle in CI.
  await writeFile(
    path.join(outDir, 'metafile.json'),
    JSON.stringify(result.metafile, null, 2),
  );
  const bundleStat = await stat(path.join(outDir, 'k1c.bundle.mjs'));
  console.log(
    `[build-wasm] bundle: ${(bundleStat.size / 1024).toFixed(1)} KB`,
  );
}

async function componentize() {
  let componentize;
  try {
    ({ componentize } = await import('@bytecodealliance/componentize-js'));
  } catch (e) {
    console.warn(
      `[build-wasm] @bytecodealliance/componentize-js not installed (${e?.message ?? e}); skipping wasm step. Bundle is still emitted.`,
    );
    return;
  }
  const bundlePath = path.join(outDir, 'k1c.bundle.mjs');
  const witPath = path.join(root, 'wit');
  console.log(
    `[build-wasm] componentize-js → wasi-cli/run (this can take ~30s)…`,
  );
  let component;
  try {
    ({ component } = await componentize({
      sourcePath: bundlePath,
      witPath,
      worldName: 'cli',
    }));
  } catch (e) {
    console.warn(
      `[build-wasm] componentize-js failed: ${e?.message ?? e}\n` +
        `[build-wasm] this is expected while wasi-http preview-2 stabilises. The bundle at ${bundlePath} can be re-componentized manually once your toolchain is ready.`,
    );
    return;
  }
  const wasmPath = path.join(outDir, 'k1c.wasm');
  await writeFile(wasmPath, component);
  const wasmStat = await stat(wasmPath);
  console.log(
    `[build-wasm] wasm: ${(wasmStat.size / 1024 / 1024).toFixed(2)} MB → ${wasmPath}`,
  );
}

await bundleEsm();
await componentize();
