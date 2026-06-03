/**
 * The schedule sidecar (`~/.tanka-wm/schedule.json`) — see `schedulePath()`.
 * Mirrors the cron expression a job was installed with so the UI can echo it;
 * the platform backend stays the source of truth for whether a job exists.
 * Reads/writes never throw (a missing or corrupt sidecar just means "no expr").
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { schedulePath } from '../config/paths';

export interface ScheduleState {
  /** the 5-field cron expression the job was installed with */
  expr: string;
  /** the binary the job invokes (`<binPath> sync`) */
  binPath: string;
}

export function readScheduleState(): ScheduleState | null {
  try {
    const raw = JSON.parse(readFileSync(schedulePath(), 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as ScheduleState).expr === 'string' &&
      typeof (raw as ScheduleState).binPath === 'string'
    ) {
      return raw as ScheduleState;
    }
  } catch {
    /* missing or corrupt — treated as no recorded expr */
  }
  return null;
}

export function writeScheduleState(state: ScheduleState): void {
  const path = schedulePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearScheduleState(): void {
  try {
    rmSync(schedulePath(), { force: true });
  } catch {
    /* already gone */
  }
}
