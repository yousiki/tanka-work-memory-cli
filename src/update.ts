/**
 * Self-update via GitHub Releases.
 *
 * Checks https://github.com/Shanda-Group-Ltd/tanka-work-memory-cli/releases
 * for a newer version and, if found, downloads the platform-matching binary
 * and replaces the running executable in-place (atomic rename).
 */
import { chmodSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { WM_TUI_VERSION } from './version';

const GITHUB_OWNER = 'Shanda-Group-Ltd';
const GITHUB_REPO = 'tanka-work-memory-cli';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

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
  /** The asset that matches the current platform, or null if none matches. */
  matchedAsset: ReleaseAsset | null;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number | null;
}

// ── Platform mapping ───────────────────────────────────────────────────────

/**
 * Map Node/Bun process.platform + process.arch → build target key used in the
 * asset filename (e.g. `darwin-arm64`, `windows-x64`).
 */
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

/**
 * Numeric semver comparison. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
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

/**
 * True when the running process is a compiled tanka-wm binary (not `bun
 * src/cli.tsx`). We refuse to self-update in dev mode to avoid clobbering the
 * Bun runtime itself.
 */
export function isCompiledBinary(): boolean {
  return basename(process.execPath).startsWith('tanka-wm');
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

/**
 * Download the matching asset and atomically replace the running binary.
 *
 * Flow: download → tmp file → rename current → .bak → rename tmp → current
 * → remove .bak. If the rename fails the .bak is kept for manual recovery.
 */
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

  if (process.platform !== 'win32') {
    chmodSync(tmpPath, 0o755);
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

/** Format bytes as human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
