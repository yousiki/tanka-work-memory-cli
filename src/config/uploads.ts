/**
 * Upload manifest — a local record of which sessions have been pushed to S3,
 * so the browser can show an "uploaded" badge without a network round-trip.
 * The manifest is a cache, not a source of truth; a Remote-view refresh
 * reconciles it against the bucket.
 *
 * On disk it is sharded by env then project: `~/.tanka-wm/uploads/<env>/<projectId>.json`,
 * each shard holding `Record<sessionId, UploadRecord>`. In memory the shards
 * are merged into a single `UploadManifest` keyed by `${projectId}/${sessionId}`
 * so callers see one flat map regardless of layout.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionRef } from '../discovery/sessions';

import type { TankaEnv } from './config';
import { projectManifestPath, uploadsDir } from './paths';

export interface UploadRecord {
  projectId: string;
  sessionId: string;
  agent: string;
  /** ISO timestamp of the most recent successful upload */
  uploadedAt: string;
  /** number of objects written (transcript + sidecar files) */
  fileCount: number;
  sizeBytes: number;
  /** transcript mtime/size at upload time — the cheap change-detection signal */
  transcriptMtimeMs: number;
  transcriptSizeBytes: number;
}

/** new = never uploaded · changed = transcript moved since upload · current = up to date */
export type UploadStatusKind = 'new' | 'changed' | 'current';

export interface UploadManifest {
  version: 1;
  /** keyed by `${projectId}/${sessionId}` */
  entries: Record<string, UploadRecord>;
}

function manifestKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

/**
 * Atomically write one project's shard. An empty shard removes the file so a
 * project with no remaining uploads leaves no stale leftover.
 */
function writeProjectShard(
  env: TankaEnv,
  projectId: string,
  shard: Record<string, UploadRecord>,
): void {
  const path = projectManifestPath(env, projectId);
  if (Object.keys(shard).length === 0) {
    try {
      rmSync(path);
    } catch {
      /* nothing to remove */
    }
    return;
  }
  mkdirSync(uploadsDir(env), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(shard, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o644);
  } catch {
    /* best effort */
  }
}

export function loadManifest(env: TankaEnv): UploadManifest {
  const entries: Record<string, UploadRecord> = {};
  let files: string[];
  try {
    files = readdirSync(uploadsDir(env));
  } catch {
    return { version: 1, entries };
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const projectId = file.slice(0, -'.json'.length);
    try {
      const shard = JSON.parse(
        readFileSync(join(uploadsDir(env), file), 'utf8'),
      ) as Record<string, UploadRecord>;
      if (shard && typeof shard === 'object') {
        for (const [sessionId, rec] of Object.entries(shard)) {
          entries[manifestKey(projectId, sessionId)] = rec;
        }
      }
    } catch {
      /* skip an unreadable shard rather than failing the whole load */
    }
  }
  return { version: 1, entries };
}

export function isUploaded(
  manifest: UploadManifest,
  projectId: string,
  sessionId: string,
): boolean {
  return Boolean(manifest.entries[manifestKey(projectId, sessionId)]);
}

/** Record a successful upload and persist the manifest. Returns the updated manifest. */
export function recordUpload(
  env: TankaEnv,
  manifest: UploadManifest,
  record: UploadRecord,
): UploadManifest {
  const next: UploadManifest = {
    version: 1,
    entries: {
      ...manifest.entries,
      [manifestKey(record.projectId, record.sessionId)]: record,
    },
  };
  // Persist only the touched project's shard — other shards are untouched.
  const shard: Record<string, UploadRecord> = {};
  for (const rec of Object.values(next.entries)) {
    if (rec.projectId === record.projectId) shard[rec.sessionId] = rec;
  }
  writeProjectShard(env, record.projectId, shard);
  return next;
}

/**
 * Drop manifest records for sessions that no longer exist locally, so a
 * never-shrinking manifest doesn't accumulate stale entries as old transcripts
 * are deleted.
 *
 * Scoped to a single project (namespace): `liveSessionIds` MUST be the complete
 * set of sessions just discovered for `projectId`. Records under other projects
 * are left untouched — callers prune a project only after actually scanning it,
 * never inferring "gone" from a namespace that simply wasn't looked at this run.
 * Only the affected shard is rewritten (and removed if it empties out).
 */
export function pruneManifest(
  env: TankaEnv,
  manifest: UploadManifest,
  projectId: string,
  liveSessionIds: Iterable<string>,
): { manifest: UploadManifest; removed: number } {
  const live =
    liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
  const entries: Record<string, UploadRecord> = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(manifest.entries)) {
    if (rec.projectId === projectId && !live.has(rec.sessionId)) {
      removed += 1;
      continue;
    }
    entries[key] = rec;
  }
  if (removed === 0) return { manifest, removed: 0 };

  const shard: Record<string, UploadRecord> = {};
  for (const rec of Object.values(entries)) {
    if (rec.projectId === projectId) shard[rec.sessionId] = rec;
  }
  writeProjectShard(env, projectId, shard);
  return { manifest: { version: 1, entries }, removed };
}

/**
 * Forget a whole project (namespace): delete every record and remove its shard
 * file. Called when a project is dropped from the config so its upload state in
 * `~/.tanka-wm` doesn't linger. Returns the number of records removed.
 */
export function dropProjectManifest(env: TankaEnv, projectId: string): number {
  return pruneManifest(env, loadManifest(env), projectId, new Set()).removed;
}

/**
 * Reconcile the ENTIRE manifest against a complete snapshot of what exists
 * locally, keyed by project namespace (`live`). Any record not present in
 * `live` is dropped — including records of a namespace that has vanished
 * altogether (a whole directory deleted).
 *
 * Use this only after an exhaustive scan (all mode), where a missing namespace
 * genuinely means "gone" rather than "not looked at". Select mode must keep
 * using {@link pruneManifest}, which is scoped to the one project it scanned.
 * Only the shards that actually changed are rewritten (and removed if emptied).
 */
export function reconcileManifest(
  env: TankaEnv,
  manifest: UploadManifest,
  live: Map<string, Set<string>>,
): { manifest: UploadManifest; removed: number } {
  const entries: Record<string, UploadRecord> = {};
  const touched = new Set<string>();
  let removed = 0;
  for (const [key, rec] of Object.entries(manifest.entries)) {
    if (live.get(rec.projectId)?.has(rec.sessionId)) {
      entries[key] = rec;
    } else {
      removed += 1;
      touched.add(rec.projectId);
    }
  }
  if (removed === 0) return { manifest, removed: 0 };
  for (const projectId of touched) {
    const shard: Record<string, UploadRecord> = {};
    for (const rec of Object.values(entries)) {
      if (rec.projectId === projectId) shard[rec.sessionId] = rec;
    }
    writeProjectShard(env, projectId, shard);
  }
  return { manifest: { version: 1, entries }, removed };
}

/**
 * Compare a freshly-discovered session against the manifest. Claude Code (and
 * the others) only ever append to a transcript, so an mtime or size change is
 * a reliable "needs re-upload" signal without hashing the whole file.
 */
export function uploadStatus(
  manifest: UploadManifest,
  projectId: string,
  ref: SessionRef,
): UploadStatusKind {
  const rec = manifest.entries[manifestKey(projectId, ref.id)];
  if (!rec) return 'new';
  if (
    rec.transcriptMtimeMs !== Math.round(ref.mtimeMs) ||
    rec.transcriptSizeBytes !== ref.sizeBytes
  ) {
    return 'changed';
  }
  return 'current';
}
