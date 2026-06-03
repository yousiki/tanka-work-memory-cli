/**
 * Self-update via GitHub Releases.
 *
 * Two modes:
 *   1. Manual: `tanka-wm update` / `tanka-wm update --check`
 *   2. Auto:   called on every CLI invocation (throttled, non-fatal).
 *      If an update is found, the binary is replaced and the CLI re-execs
 *      with the same arguments — the user sees the new version seamlessly.
 *
 * Every download is verified against checksums-sha256.txt from the same release.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { updateStatePath } from './config/paths';
import { WM_TUI_VERSION } from './version';

const GITHUB_OWNER = 'Shanda-Group-Ltd';
const GITHUB_REPO = 'tanka-work-memory-cli';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReleaseInfo {
  version: string;
  tagName: string;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  assets: ReleaseAsset[];
}

export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  release: ReleaseInfo;
  matchedAsset: ReleaseAsset | null;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number | null;
}

interface UpdateState {
  lastCheckMs: number;
  lastVersion: string;
}

// ── Platform mapping ───────────────────────────────────────────────────────

function platformKey(): string | null {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch;
  if (!['darwin', 'linux', 'windows'].includes(platform)) return null;
  if (!['x64', 'arm64'].includes(arch)) return null;
  return `${platform}-${arch}`;
}

function expectedAssetName(): string | null {
  const key = platformKey();
  if (!key) return null;
  return `tanka-wm-${key}${key.startsWith('windows-') ? '.exe' : ''}`;
}

// ── Version helpers ────────────────────────────────────────────────────────

function stripV(tag: string): string {
  return tag.replace(/^v/, '');
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ── Compiled-binary guard ──────────────────────────────────────────────────

export function isCompiledBinary(): boolean {
  return basename(process.execPath).startsWith('tanka-wm');
}

// ── Throttle state ─────────────────────────────────────────────────────────

function loadUpdateState(): UpdateState | null {
  try {
    return JSON.parse(readFileSync(updateStatePath(), 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

function saveUpdateState(state: UpdateState): void {
  const p = updateStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state)}\n`);
}

function shouldCheck(): boolean {
  const state = loadUpdateState();
  if (!state) return true;
  return Date.now() - state.lastCheckMs >= AUTO_CHECK_INTERVAL_MS;
}

// ── Core API ───────────────────────────────────────────────────────────────

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const res = await fetch(RELEASES_LATEST_URL, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'tanka-wm-updater',
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API error ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  const assets = (
    (data.assets as Array<Record<string, unknown>>) ?? []
  ).map<ReleaseAsset>((a) => ({
    name: a.name as string,
    downloadUrl: a.browser_download_url as string,
    size: a.size as number,
  }));

  const release: ReleaseInfo = {
    version: stripV(data.tag_name as string),
    tagName: data.tag_name as string,
    publishedAt: (data.published_at as string) ?? '',
    htmlUrl: (data.html_url as string) ?? '',
    body: (data.body as string) ?? '',
    assets,
  };

  const current = WM_TUI_VERSION;
  const latest = release.version;
  const hasUpdate = cmpSemver(latest, current) > 0;

  const wantAsset = expectedAssetName();
  const matchedAsset = wantAsset
    ? (assets.find((a) => a.name === wantAsset) ?? null)
    : null;

  return { current, latest, hasUpdate, release, matchedAsset };
}

// ── Checksum verification ──────────────────────────────────────────────────

function releaseDownloadUrl(
  check: UpdateCheckResult,
  assetName: string,
): string {
  const asset = check.release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `asset ${assetName} not found in release ${check.release.tagName}`,
    );
  }
  return asset.downloadUrl;
}

async function fetchExpectedHash(
  check: UpdateCheckResult,
  assetName: string,
): Promise<string> {
  const url = releaseDownloadUrl(check, 'checksums-sha256.txt');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tanka-wm-updater' },
  });
  if (!res.ok)
    throw new Error(`failed to download checksums: HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.endsWith(`  ${assetName}`));
  if (!line)
    throw new Error(`no checksum for ${assetName} in checksums-sha256.txt`);
  return line.split(/\s+/)[0]!;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ── Download + replace ─────────────────────────────────────────────────────

export async function performUpdate(
  check: UpdateCheckResult,
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  if (!check.matchedAsset) {
    throw new Error(
      `no binary available for ${process.platform}-${process.arch}` +
        ` (expected asset: ${expectedAssetName() ?? 'unknown'})`,
    );
  }

  const binPath = process.execPath;
  const binDir = dirname(binPath);
  const tmpPath = join(binDir, `.tanka-wm-update-${process.pid}.tmp`);
  const bakPath = `${binPath}.bak`;

  // Fetch expected checksum before downloading the binary
  const expectedHash = await fetchExpectedHash(check, check.matchedAsset.name);

  const res = await fetch(check.matchedAsset.downloadUrl, {
    headers: { 'User-Agent': 'tanka-wm-updater' },
  });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('download returned empty body');
  }

  const totalBytes = Number(res.headers.get('content-length')) || null;
  let downloaded = 0;

  const countingTransform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length;
      onProgress?.({ bytesDownloaded: downloaded, bytesTotal: totalBytes });
      cb(null, chunk);
    },
  });

  try {
    const out = createWriteStream(tmpPath, { mode: 0o755 });
    await pipeline(Readable.fromWeb(res.body as never), countingTransform, out);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* partial file may not exist */
    }
    throw e;
  }

  // Verify checksum
  const actualHash = sha256File(tmpPath);
  if (actualHash !== expectedHash) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    throw new Error(
      `checksum mismatch: expected ${expectedHash}, got ${actualHash}`,
    );
  }

  if (process.platform !== 'win32') {
    chmodSync(tmpPath, 0o755);
  }
  if (process.platform === 'darwin') {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('xattr', ['-d', 'com.apple.quarantine', tmpPath], {
        stdio: 'ignore',
      });
    } catch {
      /* xattr may not exist or attribute not set */
    }
  }

  // Atomic swap
  try {
    unlinkSync(bakPath);
  } catch {
    /* no previous backup */
  }
  renameSync(binPath, bakPath);
  try {
    renameSync(tmpPath, binPath);
  } catch (e) {
    try {
      renameSync(bakPath, binPath);
    } catch {
      /* best effort rollback */
    }
    throw e;
  }

  try {
    unlinkSync(bakPath);
  } catch {
    /* may still be locked on Windows */
  }

  return binPath;
}

// ── Auto-update (called on every CLI invocation) ───────────────────────────

/**
 * Non-fatal auto-update: check GitHub for a newer version (throttled), download
 * and replace the binary if found. Returns the new version string if updated,
 * or null if no update was needed/available. Never throws — any error is
 * silently swallowed so the CLI proceeds normally.
 */
export async function autoUpdate(): Promise<string | null> {
  try {
    if (!isCompiledBinary()) return null;
    if (process.env.TANKA_WM_NO_AUTO_UPDATE === '1') return null;
    if (!shouldCheck()) return null;

    const check = await checkForUpdate();

    if (!check.hasUpdate || !check.matchedAsset) {
      saveUpdateState({ lastCheckMs: Date.now(), lastVersion: check.latest });
      return null;
    }

    console.error(`updating tanka-wm: ${check.current} → ${check.latest}…`);
    await performUpdate(check);
    saveUpdateState({ lastCheckMs: Date.now(), lastVersion: check.latest });
    console.error(`updated to ${check.latest}`);

    return check.latest;
  } catch {
    return null;
  }
}

/** Format bytes as human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
