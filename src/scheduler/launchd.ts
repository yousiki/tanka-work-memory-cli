/**
 * macOS backend: a per-user LaunchAgent.
 *
 * Preferred over crontab on macOS — cron is deprecated there and its jobs run
 * outside the user's GUI session, which trips TCC (privacy) prompts when
 * reading files under ~/Documents, ~/Desktop, etc. A LaunchAgent runs as the
 * logged-in user with clean TCC attribution, and each job is its own plist
 * file (no shared-file marked-block dance), so install/remove can't disturb
 * anything else.
 *
 * Logging uses launchd's native StandardOutPath/StandardErrorPath instead of a
 * shell `>>` redirect — `sync` also writes the same wm.log itself, so this is
 * belt-and-suspenders capture of any stray stdout/stderr.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { logPath } from '../log';
import { type ParsedSchedule, parseCronExpr } from './schedule';
import {
  clearScheduleState,
  readScheduleState,
  writeScheduleState,
} from './state';
import type { Scheduler, SchedulerStatus } from './types';

const LABEL = 'ai.tanka.wm.sync';

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the LaunchAgent plist. Interval presets map to `StartInterval`
 * (seconds); a daily preset maps to `StartCalendarInterval`. Exported for
 * tests — the install path below just writes this out and (re)loads it.
 *
 * `xmlEscape` only handles `& < >`: every interpolated value here sits in a
 * `<string>` text node, where `"` and `'` are legal and need no escaping.
 * (That would change if a value were ever placed in an XML attribute.)
 */
export function buildPlist(
  binPath: string,
  schedule: ParsedSchedule,
  log: string,
): string {
  const trigger =
    schedule.type === 'interval'
      ? `  <key>StartInterval</key>\n  <integer>${schedule.seconds}</integer>`
      : `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${schedule.hour}</integer>\n    <key>Minute</key>\n    <integer>${schedule.minute}</integer>\n  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binPath)}</string>
    <string>sync</string>
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
${trigger}
</dict>
</plist>
`;
}

function tryLaunchctl(args: string[]): void {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
  } catch {
    /* best-effort: unload of a not-loaded job, etc. */
  }
}

export const launchdScheduler: Scheduler = {
  kind: 'launchd',

  available(): boolean {
    try {
      execFileSync('launchctl', ['list'], { stdio: 'ignore' });
      return true;
    } catch (e: unknown) {
      // present-but-nonzero still means launchctl exists; ENOENT means it's
      // genuinely missing. (Under bun the ENOENT error still carries a `status`
      // key — value `undefined` — so we must key off `code === 'ENOENT'`, not
      // `'status' in e`.)
      return !(
        e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT'
      );
    }
  },

  status(): SchedulerStatus {
    // A stray plist on disk isn't enough: a failed `load` or an external
    // `launchctl unload` can leave the file behind while the agent isn't
    // actually loaded. Key off whether launchd really has the job — the
    // analogue of schtasks `/query` and crontab's block check — so the UI can't
    // claim "installed" for a job that never runs.
    let loaded = false;
    try {
      execFileSync('launchctl', ['list', LABEL], { stdio: 'ignore' });
      loaded = true;
    } catch {
      loaded = false; // `list <label>` exits non-zero when not loaded
    }
    if (!loaded) return { installed: false, expr: null, detail: null };
    return {
      installed: true,
      expr: readScheduleState()?.expr ?? null,
      detail: plistPath(),
    };
  },

  install(binPath: string, expr: string): void {
    const schedule = parseCronExpr(expr);
    const path = plistPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildPlist(binPath, schedule, logPath()));
    // replace any previously-loaded version, then load the new one
    tryLaunchctl(['unload', path]);
    execFileSync('launchctl', ['load', '-w', path], { stdio: 'ignore' });
    writeScheduleState({ expr, binPath });
  },

  remove(): void {
    const path = plistPath();
    tryLaunchctl(['unload', path]);
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
    clearScheduleState();
  },
};
