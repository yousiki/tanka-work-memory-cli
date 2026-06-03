/**
 * Cross-platform release binaries via `bun build --compile`.
 *
 * Bun cross-compiles from any host — no per-target toolchain — and bundles
 * Ink's yoga-wasm asset into the binary. Bun is a build-time tool only; the
 * app's dev/test runtime stays Node.
 *
 *   bun scripts/build-binaries.mjs                  # all targets
 *   bun scripts/build-binaries.mjs darwin-arm64     # one target by name
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgDir, 'src/cli.tsx');
const outDir = join(pkgDir, 'dist');

/** Bun --target → output binary name. Bun cross-compiles every one from any host. */
const TARGETS = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64' },
  { name: 'windows-x64', bunTarget: 'bun-windows-x64' },
  { name: 'windows-arm64', bunTarget: 'bun-windows-arm64' },
];

const want = process.argv.slice(2);
const targets = want.length
  ? TARGETS.filter((t) => want.includes(t.name))
  : TARGETS;
if (targets.length === 0) {
  console.error(
    `no matching target. known: ${TARGETS.map((t) => t.name).join(', ')}`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/**
 * Collect --define flags for Tanka API base URLs. When the env vars are set
 * (CI), the values are inlined into the binary at compile time so the binary
 * works without runtime env configuration. During local dev the env vars are
 * read at runtime instead.
 */
if (!process.env.TANKA_API_URL_PROD) {
  console.error(
    '✗ TANKA_API_URL_PROD is required — set it to the production API base URL',
  );
  process.exit(1);
}

const TANKA_ENV_VARS = [
  'TANKA_API_URL_DEV',
  'TANKA_API_URL_TEST',
  'TANKA_API_URL_UAT',
  'TANKA_API_URL_PROD',
];
const defineFlags = [];
const included = [];
for (const key of TANKA_ENV_VARS) {
  const val = process.env[key];
  if (val) {
    defineFlags.push('--define', `process.env.${key}=${JSON.stringify(val)}`);
    included.push(key.replace('TANKA_API_URL_', '').toLowerCase());
  }
}
console.log(`environments: ${included.join(', ')}`);

const checksums = [];

for (const { name, bunTarget } of targets) {
  const isWindows = name.startsWith('windows-');
  const outfile = join(outDir, `tanka-wm-${name}${isWindows ? '.exe' : ''}`);
  process.stdout.write(`▶ ${name} (${bunTarget}) … `);
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=${bunTarget}`,
      ...defineFlags,
      entry,
      '--outfile',
      outfile,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const bytes = readFileSync(outfile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
  checksums.push(`${sha256}  ${basename(outfile)}`);
  console.log(
    `✓ ${basename(outfile)} (${mb} MB) sha256:${sha256.slice(0, 16)}…`,
  );
}

const checksumPath = join(outDir, 'checksums-sha256.txt');
writeFileSync(checksumPath, `${checksums.join('\n')}\n`);
console.log(`\n✓ ${checksumPath}`);
