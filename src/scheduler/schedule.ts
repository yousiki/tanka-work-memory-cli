// Minimal cron-expression parser. The TUI only ever installs one of a handful
// of fixed interval / daily presets (see `CronModal`), so this deliberately
// supports just that subset rather than a full cron grammar — enough to
// translate a preset into the native form launchd and Task Scheduler want.
//
// Recognised shapes (day-of-month / month / day-of-week must all be `*`):
//   - stepped minute, any hour      → every N minutes
//   - fixed minute, stepped hour     → every N hours (the minute offset dropped)
//   - fixed minute, any hour         → every hour (minute offset dropped)
//   - fixed minute, fixed hour       → daily at that hour:minute
//
// crontab.ts stores the expression verbatim but still calls this to validate
// the input up front; the non-cron backends additionally use the parsed result
// to build their native schedule.

export type ParsedSchedule =
  | { type: 'interval'; seconds: number }
  | { type: 'daily'; hour: number; minute: number };

const STEP = /^\*\/(\d+)$/;
const NUM = /^(\d+)$/;

function stepOf(field: string): number | null {
  const m = STEP.exec(field);
  return m ? Number(m[1]) : null;
}
function numOf(field: string): number | null {
  const m = NUM.exec(field);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a supported cron expression into a platform-neutral schedule. Throws
 * with a clear message on anything outside the supported subset, so a backend
 * can surface "unsupported schedule on this platform".
 */
export function parseCronExpr(expr: string): ParsedSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`unsupported schedule "${expr}" (expected 5 cron fields)`);
  }
  const [min, hour, dom, mon, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dom !== '*' || mon !== '*' || dow !== '*') {
    throw new Error(
      `unsupported schedule "${expr}" (day/month/weekday fields must be *)`,
    );
  }

  // stepped minute, any hour → every N minutes
  const minStep = stepOf(min);
  if (minStep !== null && hour === '*') {
    if (minStep < 1) throw new Error(`bad minute step in "${expr}"`);
    return { type: 'interval', seconds: minStep * 60 };
  }

  const minNum = numOf(min);
  if (minNum === null || minNum < 0 || minNum > 59) {
    throw new Error(`unsupported minute field in "${expr}"`);
  }

  // fixed minute, stepped hour → every N hours (period is what matters)
  const hourStep = stepOf(hour);
  if (hourStep !== null) {
    if (hourStep < 1) throw new Error(`bad hour step in "${expr}"`);
    return { type: 'interval', seconds: hourStep * 3600 };
  }

  // fixed minute, any hour → every hour
  if (hour === '*') {
    return { type: 'interval', seconds: 3600 };
  }

  // fixed minute, fixed hour → daily at hour:minute
  const hourNum = numOf(hour);
  if (hourNum === null || hourNum < 0 || hourNum > 23) {
    throw new Error(`unsupported hour field in "${expr}"`);
  }
  return { type: 'daily', hour: hourNum, minute: minNum };
}
