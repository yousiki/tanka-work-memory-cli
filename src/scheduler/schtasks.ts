/**
 * Windows backend: Task Scheduler via the built-in `schtasks.exe`.
 *
 * Chosen over the PowerShell `ScheduledTasks` module because it matches this
 * project's existing shape (execFile a CLI, like crontab), is present on every
 * Windows since XP, needs no admin (a user-level task — `/ru` omitted — runs as
 * the current interactive user), and avoids spinning up powershell.exe.
 *
 * The task lives under a `tanka-wm\` folder so `/query`, `/delete` only ever
 * touch our own task — the Task Scheduler analogue of crontab's marked block,
 * but with real per-object isolation.
 *
 * No `>>` redirect: Task Scheduler actions don't go through a shell, and `sync`
 * writes wm.log itself anyway — so the action is simply `"<bin>" sync`, with no
 * shell redirection to quote. (The `/tr` quoting of the binary itself still
 * needs real-Windows verification — see `buildCreateArgs`.)
 */
import { execFileSync } from 'node:child_process';

import { type ParsedSchedule, parseCronExpr } from './schedule';
import {
  clearScheduleState,
  readScheduleState,
  writeScheduleState,
} from './state';
import type { Scheduler, SchedulerStatus } from './types';

export const TASK_NAME = 'tanka-wm\\sync';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the `schtasks /create` argv for a schedule. Exported for tests.
 * Interval presets become `/sc minute|hourly /mo N`; a daily preset becomes
 * `/sc daily /st HH:MM`.
 *
 * The `/tr` value wraps the binary in quotes so a path with spaces launches.
 * CAVEAT: how this single argv element is serialized into the actual Windows
 * command line is up to Node/bun's child_process quoting, then re-parsed by
 * schtasks.exe — a unit test can assert this string but NOT that the resulting
 * task actually *runs*. This must be verified on real Windows (a space-bearing
 * and a space-free binPath, each install→trigger→check wm.log) before the
 * Windows path is considered done. See CLAUDE.md "Unfinished".
 */
export function buildCreateArgs(
  binPath: string,
  schedule: ParsedSchedule,
): string[] {
  let sched: string[];
  if (schedule.type === 'daily') {
    sched = [
      '/sc',
      'daily',
      '/st',
      `${pad2(schedule.hour)}:${pad2(schedule.minute)}`,
    ];
  } else if (schedule.seconds % 3600 === 0) {
    // schtasks `/sc hourly /mo` accepts 1–23 (Microsoft docs)
    const hours = schedule.seconds / 3600;
    if (hours > 23) {
      throw new Error(
        `schtasks /sc hourly supports up to 23 hours; got ${hours}`,
      );
    }
    sched = ['/sc', 'hourly', '/mo', String(hours)];
  } else if (schedule.seconds % 60 === 0) {
    // schtasks `/sc minute /mo` accepts 1–1439 (Microsoft docs)
    const minutes = schedule.seconds / 60;
    if (minutes > 1439) {
      throw new Error(
        `schtasks /sc minute supports up to 1439 minutes; got ${minutes}`,
      );
    }
    sched = ['/sc', 'minute', '/mo', String(minutes)];
  } else {
    throw new Error(
      `schtasks cannot represent a ${schedule.seconds}s interval`,
    );
  }
  return [
    '/create',
    '/tn',
    TASK_NAME,
    '/tr',
    `"${binPath}" sync`,
    ...sched,
    '/f',
  ];
}

export const schtasksScheduler: Scheduler = {
  kind: 'schtasks',

  available(): boolean {
    try {
      execFileSync('schtasks', ['/query'], { stdio: 'ignore' });
      return true;
    } catch (e: unknown) {
      // present-but-nonzero still means schtasks exists; ENOENT means it's
      // genuinely missing (e.g. running under a non-Windows shim). (Under bun
      // the ENOENT error still carries a `status` key — value `undefined` — so
      // we must key off `code === 'ENOENT'`, not `'status' in e`.)
      return !(
        e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT'
      );
    }
  },

  status(): SchedulerStatus {
    let installed = false;
    try {
      execFileSync('schtasks', ['/query', '/tn', TASK_NAME], {
        stdio: 'ignore',
      });
      installed = true;
    } catch {
      installed = false; // /query of a missing task exits non-zero
    }
    if (!installed) return { installed: false, expr: null, detail: null };
    return {
      installed: true,
      expr: readScheduleState()?.expr ?? null,
      detail: TASK_NAME,
    };
  },

  install(binPath: string, expr: string): void {
    const args = buildCreateArgs(binPath, parseCronExpr(expr));
    execFileSync('schtasks', args, { stdio: 'ignore' });
    writeScheduleState({ expr, binPath });
  },

  remove(): void {
    try {
      execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], {
        stdio: 'ignore',
      });
    } catch {
      /* not installed */
    }
    clearScheduleState();
  },
};
