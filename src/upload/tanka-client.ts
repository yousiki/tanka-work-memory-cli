/**
 * Tanka open-file-upload client — the two-step upload protocol.
 *
 *   1. POST {baseUrl}/open/file/upload/application  (header: token)
 *      → body { files: [...] } describing each file; response carries a
 *        per-file S3 pre-signed `uploadUrl`.
 *   2. PUT <uploadUrl>  with the raw bytes + Content-Type + Content-MD5
 *      (both must match what was declared in step 1, since they're baked into
 *      the pre-signed URL's signature).
 *
 * One session uploads as several files (transcript.jsonl + sidecar files)
 * sharing a single `groupId`. The upload is considered complete when the
 * caller's subsequent POST /sync succeeds (not when the last PUT finishes).
 *
 * KNOWN LIMITATION — orphaned objects on partial failure: the PUTs are not
 * transactional. If a later file's PUT throws, the files already PUT this run
 * stay in S3 but POST /sync is never called, so no `fileId` is ever registered
 * and the manifest is not written (the session is correctly retried next run
 * under a *new* groupId). The earlier objects are thus unreferenced. This does
 * not affect correctness — /sync is the sole completion marker — it only leaks
 * storage, and the backend is expected to GC objects of a groupId that never
 * completed a /sync. The CLI does not attempt client-side cleanup.
 *
 * Stdlib only: global `fetch` (Node 20+) + node:crypto. No third-party deps.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { TANKA_ENVS, type TankaEnv } from '../config/config';
import type { SessionRef } from '../discovery/sessions';

/**
 * API base URL resolution via environment variables.
 *
 * Each Tanka environment reads its URL from `TANKA_API_URL_<ENV>`. Static
 * `process.env.*` access is intentional — `bun build --compile --define` can
 * inline the values at compile time (CI), while local dev reads them at runtime
 * from the shell environment. This keeps internal hostnames out of source code.
 */
const APPLY_PATH = '/open/file/upload/application';
const MODULE = 'memory-work';

function envUrls(): Record<TankaEnv, string | undefined> {
  return {
    dev: process.env.TANKA_API_URL_DEV,
    test: process.env.TANKA_API_URL_TEST,
    uat: process.env.TANKA_API_URL_UAT,
    prod: process.env.TANKA_API_URL_PROD,
  };
}

/** Environments whose API URL is configured (compile-time or runtime). */
export function availableEnvs(): TankaEnv[] {
  const urls = envUrls();
  return TANKA_ENVS.filter((e) => !!urls[e]?.trim());
}

export function resolveBaseUrl(env: TankaEnv): string {
  const url = envUrls()[env]?.trim();
  if (!url) {
    throw new Error(
      `environment "${env}" is not available — TANKA_API_URL_${env.toUpperCase()} is not configured`,
    );
  }
  return url;
}

export class TokenExpiredError extends Error {
  constructor(
    message = 'token invalid or expired (HTTP 401) — re-configure your Tanka token',
  ) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export interface UploadProgress {
  label: string;
  done: number;
  total: number;
}

/** One uploaded file's backend identity, keyed back to its session-relative path. */
export interface UploadedFile {
  /** 'transcript.jsonl' | 'subagents/agent-a1.jsonl' | 'tool-results/x' | … */
  relPath: string;
  fileId: string;
  /** object storage URI */
  url: string;
  sizeBytes: number;
}

export interface UploadOutcome {
  fileCount: number;
  sizeBytes: number;
  transcriptFileId: string;
  transcriptUrl: string;
  /** every file PUT this session (transcript + sidecars), keyed by relPath */
  files: UploadedFile[];
}

interface FileItem {
  relPath: string;
  baseName: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
  contentLength: number;
  contentMD5: string;
  contentDisposition: string;
}

interface ApplyRespFile {
  fileId: string;
  localId: string | null;
  url: string;
  uploadUrl: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jsonl': 'application/x-ndjson',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function contentTypeFor(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot >= 0) {
    const ext = relPath.slice(dot).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (mime) return mime;
  }
  return 'text/plain; charset=utf-8';
}

function md5Base64(buf: Buffer): string {
  return createHash('md5').update(buf).digest('base64');
}

function posixBasename(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

function fileNameFor(sessionId: string, relPath: string): string {
  const noExt = relPath.replace(/\.[^./]+$/, '');
  return `${sessionId}_${noExt.replace(/\//g, '_')}`;
}

function buildItem(
  sessionId: string,
  relPath: string,
  buffer: Buffer,
): FileItem {
  const baseName = posixBasename(relPath);
  return {
    relPath,
    baseName,
    buffer,
    contentType: contentTypeFor(relPath),
    fileName: fileNameFor(sessionId, relPath),
    contentLength: buffer.byteLength,
    contentMD5: md5Base64(buffer),
    contentDisposition: `attachment;filename=${baseName}`,
  };
}

function collectItems(ref: SessionRef): FileItem[] {
  const items: FileItem[] = [];
  items.push(buildItem(ref.id, 'transcript.jsonl', readFileSync(ref.path)));
  for (const f of ref.sidecarFiles) {
    if (f.sizeBytes <= 0) continue;
    items.push(buildItem(ref.id, f.relPath, readFileSync(f.absPath)));
  }
  return items;
}

function groupIdFor(remoteProjectId: string): string {
  return `wm-session-${remoteProjectId}-${randomUUID().slice(0, 12)}`;
}

async function applyUpload(
  token: string,
  env: TankaEnv,
  groupId: string,
  items: FileItem[],
): Promise<ApplyRespFile[]> {
  const body = {
    files: items.map((it) => ({
      module: MODULE,
      type: MODULE,
      contentType: it.contentType,
      contentDisposition: it.contentDisposition,
      contentMD5: it.contentMD5,
      fileName: it.fileName,
      groupId,
      fileId: '',
      contentLength: it.contentLength,
      localId: it.relPath,
    })),
  };

  const resp = await fetch(`${resolveBaseUrl(env)}${APPLY_PATH}`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) throw new TokenExpiredError();
  if (!resp.ok) {
    throw new Error(
      `upload application failed: HTTP ${resp.status} ${await safeText(resp)}`,
    );
  }
  const json = (await resp.json()) as {
    code: number;
    msg?: string;
    data?: { files?: ApplyRespFile[] };
  };
  if (json.code !== 0)
    throw new Error(
      `upload application rejected: ${json.msg ?? `code ${json.code}`}`,
    );
  const files = json.data?.files ?? [];
  if (files.length !== items.length) {
    throw new Error(
      `upload application returned ${files.length} targets for ${items.length} files`,
    );
  }
  return files;
}

function targetForIndex(
  items: FileItem[],
  targets: ApplyRespFile[],
  i: number,
): ApplyRespFile {
  const item = items[i]!;
  const byId = targets.find(
    (t) => t.localId != null && t.localId === item.relPath,
  );
  return byId ?? targets[i]!;
}

async function putBytes(target: ApplyRespFile, item: FileItem): Promise<void> {
  const resp = await fetch(target.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': item.contentType,
      'Content-MD5': item.contentMD5,
      'Content-Disposition': item.contentDisposition,
      // The pre-signed URL signs content-length explicitly, so set it byte-for-
      // byte rather than relying on fetch to auto-derive it from the body — a
      // missing/mismatched header makes S3 reject the PUT with SignatureDoesNotMatch.
      'Content-Length': String(item.contentLength),
    },
    body: item.buffer,
  });
  if (!resp.ok) {
    throw new Error(
      `PUT ${item.relPath} failed: HTTP ${resp.status} ${await safeText(resp)}`,
    );
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Upload one discovered session's files to S3 via the two-step protocol.
 * Returns the transcript's `fileId` + `url` for the caller to pass to
 * POST /sync. Throws TokenExpiredError on 401.
 *
 * @param remoteProjectId — backend project nanoid, used for the groupId prefix
 */
export async function uploadSession(
  token: string,
  env: TankaEnv,
  ref: SessionRef,
  onProgress: (p: UploadProgress) => void,
  remoteProjectId: string,
): Promise<UploadOutcome> {
  const items = collectItems(ref);
  const total = items.length;
  const groupId = groupIdFor(remoteProjectId);
  const targets = await applyUpload(token, env, groupId, items);

  let done = 0;
  let sizeBytes = 0;
  const files: UploadedFile[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    onProgress({ label: item.relPath, done, total });
    const target = targetForIndex(items, targets, i);
    await putBytes(target, item);
    sizeBytes += item.contentLength;
    files.push({
      relPath: item.relPath,
      fileId: target.fileId,
      url: target.url,
      sizeBytes: item.contentLength,
    });
    done += 1;
  }
  onProgress({ label: 'done', done, total });

  const transcript =
    files.find((f) => f.relPath === 'transcript.jsonl') ?? files[0]!;

  return {
    fileCount: total,
    sizeBytes,
    transcriptFileId: transcript.fileId,
    transcriptUrl: transcript.url,
    files,
  };
}

/**
 * Connectivity test: POST an application for a 1-byte probe (no PUT). Verifies
 * the base URL is reachable and the token is accepted.
 */
export async function testConnection(
  token: string,
  env: TankaEnv,
): Promise<void> {
  const probe = Buffer.from([0]);
  const item: FileItem = {
    relPath: 'connectivity-probe',
    baseName: 'connectivity-probe',
    buffer: probe,
    contentType: 'application/octet-stream',
    fileName: 'wm-connectivity-probe',
    contentLength: probe.byteLength,
    contentMD5: md5Base64(probe),
    contentDisposition: 'attachment;filename=connectivity-probe',
  };
  await applyUpload(token, env, 'wm-connectivity-probe', [item]);
}
