/**
 * Scheduled-upload facade. Picks the OS-appropriate backend once and exposes
 * the four operations the TUI / CLI need. See `types.ts` for the contract and
 * the per-backend files for the platform specifics.
 */
import { crontabScheduler } from './crontab';
import { launchdScheduler } from './launchd';
import { schtasksScheduler } from './schtasks';
import type { Scheduler, SchedulerStatus } from './types';

export type { Scheduler, SchedulerStatus } from './types';

/** Resolve the backend for a platform — injectable for tests. */
export function pickScheduler(
  platform: NodeJS.Platform = process.platform,
): Scheduler {
  if (platform === 'darwin') return launchdScheduler;
  if (platform === 'win32') return schtasksScheduler;
  return crontabScheduler; // linux + everything else
}

const active = pickScheduler();

/** Which backend is active here — 'crontab' | 'launchd' | 'schtasks'. */
export function schedulerKind(): Scheduler['kind'] {
  return active.kind;
}

export function schedulerAvailable(): boolean {
  return active.available();
}

export function schedulerStatus(): SchedulerStatus {
  return active.status();
}

export function installSchedule(binPath: string, expr: string): void {
  active.install(binPath, expr);
}

export function removeSchedule(): void {
  active.remove();
}
