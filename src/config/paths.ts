/** Filesystem locations for the TUI's own state. */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TankaEnv } from './config';

/**
 * Root of all local persisted state (config, credentials, manifest, log):
 * ~/.tanka-wm. Overridable via TANKA_WM_HOME (used by tests).
 */
export function tuiHome(): string {
  const override = process.env.TANKA_WM_HOME?.trim();
  return override && override.length > 0
    ? override
    : join(homedir(), '.tanka-wm');
}

export function configPath(): string {
  return join(tuiHome(), 'config.json');
}

/** Credentials live in their own file so it can carry stricter (0600) permissions. */
export function credentialsPath(): string {
  return join(tuiHome(), 'credentials.json');
}

/**
 * Sidecar recording the *currently installed* scheduled-upload job
 * (`{ expr, binPath }`). The scheduler backends (crontab / launchd / schtasks)
 * each persist the schedule in their own native form, but launchd's
 * `StartInterval` and schtasks' localized `/query` output can't be losslessly
 * reverse-mapped back to a cron expression for the UI to echo — so the cron
 * expr is mirrored here on install and read back for display. The platform
 * remains the source of truth for *whether* a job is installed; this file only
 * supplies the expr label.
 */
export function schedulePath(): string {
  return join(tuiHome(), 'schedule.json');
}

/**
 * Directory of per-project upload manifests, namespaced by env: each env gets
 * its own `uploads/<env>/` subdir so switching env can't cross-contaminate the
 * "already uploaded" state. Each project (namespace) gets its own
 * `<projectId>.json` shard holding `Record<sessionId, UploadRecord>`.
 */
export function uploadsDir(env: TankaEnv): string {
  return join(tuiHome(), 'uploads', env);
}

/** Manifest shard for a single project (namespace) inside `uploadsDir(env)`. */
export function projectManifestPath(env: TankaEnv, projectId: string): string {
  return join(uploadsDir(env), `${projectId}.json`);
}

/**
 * All-mode mapping: cwd path → remoteProjectId, namespaced by env at
 * `project-map/<env>.json` (the remoteProjectId is issued by one env's backend,
 * so the mapping must not be shared across envs). Lazily created when the first
 * all-mode sync creates a remote project for a discovered cwd.
 */
export function projectMapPath(env: TankaEnv): string {
  return join(tuiHome(), 'project-map', `${env}.json`);
}

/**
 * Advisory lock held for the duration of a `runSync`. Prevents a cron-triggered
 * sync and an interactive (Board) sync — or two overlapping cron runs — from
 * racing the read-modify-write of the manifest / project-map, which would
 * otherwise drop records or (in all mode) create duplicate remote projects.
 */
export function syncLockPath(): string {
  return join(tuiHome(), 'sync.lock');
}
