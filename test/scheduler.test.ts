import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { crontabScheduler } from '../src/scheduler/crontab';
import { pickScheduler } from '../src/scheduler/index';
import { buildPlist, launchdScheduler } from '../src/scheduler/launchd';
import { parseCronExpr } from '../src/scheduler/schedule';
import {
  buildCreateArgs,
  schtasksScheduler,
  TASK_NAME,
} from '../src/scheduler/schtasks';

// ── parseCronExpr: the preset subset the TUI installs ─────────────────────────

test('parseCronExpr maps every-N-minutes presets to interval seconds', () => {
  assert.deepEqual(parseCronExpr('*/15 * * * *'), {
    type: 'interval',
    seconds: 900,
  });
  assert.deepEqual(parseCronExpr('*/30 * * * *'), {
    type: 'interval',
    seconds: 1800,
  });
});

test('parseCronExpr maps hourly + every-N-hours presets to interval seconds', () => {
  assert.deepEqual(parseCronExpr('0 * * * *'), {
    type: 'interval',
    seconds: 3600,
  });
  assert.deepEqual(parseCronExpr('0 */2 * * *'), {
    type: 'interval',
    seconds: 7200,
  });
  assert.deepEqual(parseCronExpr('0 */4 * * *'), {
    type: 'interval',
    seconds: 14400,
  });
  assert.deepEqual(parseCronExpr('0 */6 * * *'), {
    type: 'interval',
    seconds: 21600,
  });
});

test('parseCronExpr maps a daily preset to hour/minute', () => {
  assert.deepEqual(parseCronExpr('0 9 * * *'), {
    type: 'daily',
    hour: 9,
    minute: 0,
  });
  assert.deepEqual(parseCronExpr('30 17 * * *'), {
    type: 'daily',
    hour: 17,
    minute: 30,
  });
});

test('parseCronExpr rejects unsupported shapes', () => {
  assert.throws(() => parseCronExpr('* * * * *')); // unbounded every-minute (no step)
  assert.throws(() => parseCronExpr('0 0 1 * *')); // day-of-month set
  assert.throws(() => parseCronExpr('0 9 * * 1')); // weekday set
  assert.throws(() => parseCronExpr('0 9 * *')); // too few fields
});

// ── schtasks argv construction (pure; no Windows needed) ──────────────────────

test('buildCreateArgs: minute interval → /sc minute /mo N', () => {
  const args = buildCreateArgs('C:\\apps\\tanka-wm.exe', {
    type: 'interval',
    seconds: 900,
  });
  assert.deepEqual(args, [
    '/create',
    '/tn',
    TASK_NAME,
    '/tr',
    '"C:\\apps\\tanka-wm.exe" sync',
    '/sc',
    'minute',
    '/mo',
    '15',
    '/f',
  ]);
});

test('buildCreateArgs: hour interval → /sc hourly /mo N', () => {
  const args = buildCreateArgs('C:\\tanka-wm.exe', {
    type: 'interval',
    seconds: 14400,
  });
  assert.ok(args.includes('hourly'));
  assert.equal(args[args.indexOf('/mo') + 1], '4');
});

test('buildCreateArgs: daily → /sc daily /st HH:MM zero-padded', () => {
  const args = buildCreateArgs('wm.exe', {
    type: 'daily',
    hour: 9,
    minute: 0,
  });
  assert.ok(args.includes('daily'));
  assert.equal(args[args.indexOf('/st') + 1], '09:00');
});

test('buildCreateArgs: /tr quotes the binary so spaces survive', () => {
  const args = buildCreateArgs('C:\\Program Files\\tanka-wm.exe', {
    type: 'interval',
    seconds: 3600,
  });
  assert.equal(
    args[args.indexOf('/tr') + 1],
    '"C:\\Program Files\\tanka-wm.exe" sync',
  );
});

// ── launchd plist rendering (pure) ────────────────────────────────────────────

test('buildPlist: interval → StartInterval, no calendar key', () => {
  const plist = buildPlist(
    '/usr/local/bin/tanka-wm',
    {
      type: 'interval',
      seconds: 1800,
    },
    '/home/u/.tanka-wm/wm.log',
  );
  assert.ok(plist.includes('<key>StartInterval</key>'));
  assert.ok(plist.includes('<integer>1800</integer>'));
  assert.ok(!plist.includes('StartCalendarInterval'));
  assert.ok(plist.includes('<string>/usr/local/bin/tanka-wm</string>'));
  assert.ok(plist.includes('<string>sync</string>'));
});

test('buildPlist: daily → StartCalendarInterval with Hour/Minute', () => {
  const plist = buildPlist(
    '/bin/wm',
    {
      type: 'daily',
      hour: 9,
      minute: 5,
    },
    '/log',
  );
  assert.ok(plist.includes('<key>StartCalendarInterval</key>'));
  assert.ok(plist.includes('<key>Hour</key>'));
  assert.ok(plist.includes('<integer>9</integer>'));
  assert.ok(plist.includes('<integer>5</integer>'));
  assert.ok(!plist.includes('StartInterval'));
});

test('buildPlist: XML-escapes special chars in paths', () => {
  const plist = buildPlist(
    '/bin/a&b',
    {
      type: 'interval',
      seconds: 60,
    },
    '/log',
  );
  assert.ok(plist.includes('/bin/a&amp;b'));
  assert.ok(!plist.includes('/bin/a&b<'));
});

// ── backend routing ───────────────────────────────────────────────────────────

test('pickScheduler routes per platform', () => {
  assert.equal(pickScheduler('darwin'), launchdScheduler);
  assert.equal(pickScheduler('win32'), schtasksScheduler);
  assert.equal(pickScheduler('linux'), crontabScheduler);
  assert.equal(pickScheduler('freebsd'), crontabScheduler); // fallback
});

test('each backend advertises its kind', () => {
  assert.equal(crontabScheduler.kind, 'crontab');
  assert.equal(launchdScheduler.kind, 'launchd');
  assert.equal(schtasksScheduler.kind, 'schtasks');
});

// ── available() must treat a missing binary as unavailable ────────────────────
// Regression guard: under bun, an execFileSync ENOENT error STILL carries a
// `status` key (value undefined), so the old `'status' in e` test wrongly
// classified a missing scheduler binary as "available". The backends now key
// off `code === 'ENOENT'`. This pins the runtime fact that justifies that.

test('bun execFileSync ENOENT exposes code, not a numeric status', () => {
  let caught: (NodeJS.ErrnoException & { status?: unknown }) | null = null;
  try {
    execFileSync('tanka-wm-no-such-binary-xyz', ['--nope'], {
      stdio: 'ignore',
    });
  } catch (e) {
    caught = e as NodeJS.ErrnoException & { status?: unknown };
  }
  assert.ok(caught, 'spawning a missing binary should throw');
  assert.equal(caught?.code, 'ENOENT');
  // The discriminator the backends rely on: ENOENT => not a numeric exit status.
  assert.notEqual(typeof caught?.status, 'number');
  // And the foot-gun this replaced: `'status' in e` is true even for ENOENT,
  // which is exactly why the backends can't use it to detect a missing binary.
  assert.ok('status' in (caught as object));
});

// ── schtasks /mo range guard (reachable via `wm cron install <expr>`) ─────────

test('buildCreateArgs throws past schtasks /mo limits', () => {
  // /sc hourly /mo max 23 → a 24h interval is out of range
  assert.throws(() =>
    buildCreateArgs('wm', { type: 'interval', seconds: 24 * 3600 }),
  );
  // /sc minute /mo max 1439 → a 1441-minute interval is out of range
  assert.throws(() =>
    buildCreateArgs('wm', { type: 'interval', seconds: 1441 * 60 }),
  );
  // an interval schtasks can't express at all (not a whole minute/hour)
  assert.throws(() => buildCreateArgs('wm', { type: 'interval', seconds: 90 }));
});

test('buildCreateArgs: daily midnight → /st 00:00 (zeros not dropped)', () => {
  const args = buildCreateArgs('wm', { type: 'daily', hour: 0, minute: 0 });
  assert.equal(args[args.indexOf('/st') + 1], '00:00');
});

// ── parseCronExpr edge cases ──────────────────────────────────────────────────

test('parseCronExpr rejects zero steps and out-of-range fields', () => {
  assert.throws(() => parseCronExpr('*/0 * * * *')); // zero minute step
  assert.throws(() => parseCronExpr('0 */0 * * *')); // zero hour step
  assert.throws(() => parseCronExpr('61 9 * * *')); // minute > 59
  assert.throws(() => parseCronExpr('0 25 * * *')); // hour > 23
});

test('parseCronExpr tolerates surrounding whitespace', () => {
  assert.deepEqual(parseCronExpr('  0 9 * * *  '), {
    type: 'daily',
    hour: 9,
    minute: 0,
  });
});

test('parseCronExpr drops the minute offset on stepped-hour exprs', () => {
  // documented lossy behaviour: the "5" is dropped, only the 2h period survives
  assert.deepEqual(parseCronExpr('5 */2 * * *'), {
    type: 'interval',
    seconds: 7200,
  });
});

test('buildPlist: daily at midnight emits explicit zero Hour/Minute', () => {
  const plist = buildPlist(
    '/bin/wm',
    { type: 'daily', hour: 0, minute: 0 },
    '/log',
  );
  assert.ok(plist.includes('<key>Hour</key>'));
  // zeros must be emitted as <integer>0</integer>, not dropped as falsy
  assert.ok(plist.includes('<integer>0</integer>'));
});
