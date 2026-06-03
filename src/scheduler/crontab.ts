/**
 * Linux (and any other non-darwin, non-win32) backend: the system `crontab`.
 *
 * crontab is a single per-user file shared with everything else the user
 * schedules, so the job is kept inside a marked block — install/remove only
 * ever rewrite our own lines. (launchd and Task Scheduler don't need this
 * dance: there each job is its own object.)
 */
import { execFileSync } from 'node:child_process';

import { logPath } from '../log';
import { parseCronExpr } from './schedule';
import {
  clearScheduleState,
  readScheduleState,
  writeScheduleState,
} from './state';
import type { Scheduler, SchedulerStatus } from './types';

const BEGIN = '# >>> work-memory-tui >>>';
const END = '# <<< work-memory-tui <<<';

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return ''; // no crontab yet, or crontab unavailable
  }
}

function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], { input: content });
}

/** Drop our marked block from a crontab body, leaving everything else intact. */
function stripBlock(tab: string): string {
  const re = new RegExp(`\\n?${BEGIN}\\n[\\s\\S]*?\\n${END}\\n?`, 'g');
  return tab.replace(re, '\n').replace(/^\n+/, '');
}

export const crontabScheduler: Scheduler = {
  kind: 'crontab',

  available(): boolean {
    try {
      execFileSync('crontab', ['-l'], { stdio: 'ignore' });
      return true;
    } catch (e: unknown) {
      // exit 1 with "no crontab for user" still means crontab exists; a missing
      // binary throws ENOENT, which means it's genuinely absent. (Under bun the
      // ENOENT error still carries a `status` key — value `undefined` — so we
      // must key off `code === 'ENOENT'`, not `'status' in e`.)
      return !(
        e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT'
      );
    }
  },

  status(): SchedulerStatus {
    const tab = readCrontab();
    const m = new RegExp(`${BEGIN}\\n([\\s\\S]*?)\\n${END}`).exec(tab);
    if (!m) return { installed: false, expr: null, detail: null };
    const line =
      m[1]!.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ??
      null;
    // the cron line carries the full expr, so it's the source of truth here;
    // the sidecar only backs the (rare) unreadable-line case.
    const lineExpr = line
      ? line.trim().split(/\s+/).slice(0, 5).join(' ')
      : null;
    const expr = lineExpr ?? readScheduleState()?.expr ?? null;
    return { installed: true, expr, detail: line };
  },

  install(binPath: string, expr: string): void {
    parseCronExpr(expr); // validate up front; crontab itself stores it verbatim
    const line = `${expr} "${binPath}" sync >> "${logPath()}" 2>&1`;
    const block = `${BEGIN}\n${line}\n${END}`;
    const base = stripBlock(readCrontab()).trimEnd();
    writeCrontab(`${(base ? `${base}\n` : '') + block}\n`);
    writeScheduleState({ expr, binPath });
  },

  remove(): void {
    const base = stripBlock(readCrontab()).trimEnd();
    writeCrontab(base ? `${base}\n` : '');
    clearScheduleState();
  },
};
