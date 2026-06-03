/**
 * Cross-platform scheduled-upload abstraction. One `Scheduler` per OS family
 * backs the same four operations; `index.ts` picks the right one from
 * `process.platform`:
 *
 *   - linux / other → crontab.ts  (system `crontab`)
 *   - darwin        → launchd.ts  (per-user LaunchAgent plist)
 *   - win32         → schtasks.ts (Task Scheduler via `schtasks.exe`)
 *
 * All three install a job that runs `<binPath> sync`. The job's identity is a
 * fixed name/label per backend, so install/remove only ever touch our own
 * entry and never the user's other scheduled tasks.
 */

export interface SchedulerStatus {
  /** whether our scheduled-upload job is currently installed */
  installed: boolean;
  /**
   * the 5-field cron expression the job was installed with, for the UI to echo
   * (e.g. highlight the matching interval preset). Sourced from the schedule
   * sidecar; null when not installed or the sidecar is missing.
   */
  expr: string | null;
  /** a backend-native one-liner for diagnostics (crontab line / plist path / task name) */
  detail: string | null;
}

export interface Scheduler {
  /** which backend this is — surfaced in the UI subtitle */
  readonly kind: 'crontab' | 'launchd' | 'schtasks';
  /** true iff this backend's underlying mechanism is callable on this machine */
  available(): boolean;
  status(): SchedulerStatus;
  /**
   * Install (or replace) the scheduled-upload job. `expr` is a 5-field cron
   * expression; backends that aren't cron-native translate it via
   * `parseCronExpr`. Throws on an expression they can't represent.
   */
  install(binPath: string, expr: string): void;
  remove(): void;
}
