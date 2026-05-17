#!/usr/bin/env node
// Fetch the controller-tools envtest tarball (etcd + kube-apiserver +
// kubectl binaries) and extract it under node_modules/.cache/envtest/
// so vitest can spawn an in-process apiserver without Docker.
//
// Idempotent: skips download if the target dir already has the three
// binaries. Verifies the tarball's SHA512 against the upstream index
// (envtest-releases.yaml) before extracting.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const VERSION = process.env['ENVTEST_K8S_VERSION'] ?? '1.36.0';
const RELEASES_URL =
  'https://raw.githubusercontent.com/kubernetes-sigs/controller-tools/main/envtest-releases.yaml';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TARGET_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'envtest', `v${VERSION}`);
const BINARIES = ['etcd', 'kube-apiserver', 'kubectl'];

function platformTag() {
  const os =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'windows'
          : null;
  if (os === null) throw new Error(`unsupported platform: ${process.platform}`);
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (arch === null) throw new Error(`unsupported arch: ${process.arch}`);
  return { os, arch };
}

async function alreadyInstalled() {
  try {
    for (const b of BINARIES) {
      const s = await stat(join(TARGET_DIR, b));
      if (!s.isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchHash(os, arch) {
  // envtest-releases.yaml is small YAML, but we avoid pulling a YAML
  // parser by scraping the line we need with a regex. The format is
  // strictly two-space indentation, so this is unambiguous.
  const res = await fetch(RELEASES_URL);
  if (!res.ok) throw new Error(`GET ${RELEASES_URL}: ${res.status}`);
  const body = await res.text();
  const fname = `envtest-v${VERSION}-${os}-${arch}.tar.gz`;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === `${fname}:`) {
      const hashLine = lines[i + 1]?.trim() ?? '';
      const m = hashLine.match(/^hash:\s*([0-9a-f]+)/);
      if (m) return m[1];
    }
  }
  throw new Error(`hash for ${fname} not found in envtest-releases.yaml`);
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) throw new Error(`GET ${url}: ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function sha512(path) {
  const buf = await readFile(path);
  return createHash('sha512').update(buf).digest('hex');
}

function runTar(tarball, outDir) {
  return new Promise((resolveRun, rejectRun) => {
    // Strip the "controller-tools/envtest/" prefix so binaries land
    // directly in TARGET_DIR.
    const proc = spawn(
      'tar',
      ['xzf', tarball, '-C', outDir, '--strip-components=2', 'controller-tools/envtest'],
      { stdio: 'inherit' },
    );
    proc.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`tar exited ${code}`));
    });
    proc.on('error', rejectRun);
  });
}

async function main() {
  if (await alreadyInstalled()) {
    console.log(`envtest v${VERSION} already installed at ${TARGET_DIR}`);
    return;
  }
  const { os, arch } = platformTag();
  const fname = `envtest-v${VERSION}-${os}-${arch}.tar.gz`;
  const url = `https://github.com/kubernetes-sigs/controller-tools/releases/download/envtest-v${VERSION}/${fname}`;
  console.log(`fetching ${url}`);
  const tarball = join(tmpdir(), fname);
  await downloadTo(url, tarball);
  const expected = await fetchHash(os, arch);
  const actual = await sha512(tarball);
  if (actual !== expected) {
    throw new Error(`sha512 mismatch for ${fname}: expected ${expected}, got ${actual}`);
  }
  await mkdir(TARGET_DIR, { recursive: true });
  await runTar(tarball, TARGET_DIR);
  for (const b of BINARIES) await chmod(join(TARGET_DIR, b), 0o755);
  console.log(`installed envtest v${VERSION} to ${TARGET_DIR}`);
}

main().catch((err) => {
  console.error(`setup-envtest: ${err.message ?? err}`);
  process.exit(1);
});
