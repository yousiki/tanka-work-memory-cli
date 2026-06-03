import { afterEach, beforeEach, setSystemTime, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncLockPath } from '../src/config/paths';
import {
  lookupRemoteProjectId,
  pruneProjectMap,
  recordProjectMapping,
} from '../src/config/project-map';
import { acquireSyncLock } from '../src/sync-lock';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-tui-lock-'));
  process.env.TANKA_WM_HOME = home;
});
afterEach(() => {
  delete process.env.TANKA_WM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('acquire creates the lock file and records our pid', () => {
  const lock = acquireSyncLock();
  assert.ok(lock, 'first acquire should succeed');
  assert.equal(existsSync(syncLockPath()), true);
  const body = JSON.parse(readFileSync(syncLockPath(), 'utf8'));
  assert.equal(body.pid, process.pid);
  lock?.release();
  assert.equal(existsSync(syncLockPath()), false);
});

test('second acquire is refused while a live lock is held', () => {
  const first = acquireSyncLock();
  assert.ok(first);
  // A lock owned by THIS (alive) pid must not be stealable.
  const second = acquireSyncLock();
  assert.equal(second, null, 'live lock should refuse a second acquire');
  first?.release();
});

test('a stale lock (dead pid) is stolen', () => {
  // Forge a lock owned by a pid that cannot exist (kernel pids are never this high).
  writeFileSync(
    syncLockPath(),
    JSON.stringify({ pid: 2 ** 30, startedAt: '2000-01-01T00:00:00.000Z' }),
  );
  const lock = acquireSyncLock();
  assert.ok(lock, 'dead-pid lock should be stolen');
  const body = JSON.parse(readFileSync(syncLockPath(), 'utf8'));
  assert.equal(body.pid, process.pid);
  lock?.release();
});

test('a stale lock (timed out) is stolen even if pid looks alive', () => {
  // Owned by our own (alive) pid, but mtime far in the past → exceeds STALE_MS.
  writeFileSync(
    syncLockPath(),
    JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z' }),
  );
  const longAgo = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(syncLockPath(), longAgo, longAgo);
  const lock = acquireSyncLock();
  assert.ok(lock, 'timed-out lock should be stolen');
  lock?.release();
});

test('a fresh but empty lock file is NOT stolen (mid-creation window)', () => {
  // Simulates the window between openSync('wx') and writeFileSync: the file
  // exists, is fresh, but has no parseable body. Stealing it would let two runs
  // both enter the critical section — so acquire must back off and return null.
  writeFileSync(syncLockPath(), '');
  const lock = acquireSyncLock();
  assert.equal(lock, null, 'fresh empty lock must not be stolen');
});

test('a fresh unparseable lock file is NOT stolen', () => {
  writeFileSync(syncLockPath(), 'not json at all');
  const lock = acquireSyncLock();
  assert.equal(lock, null, 'fresh garbage lock must not be stolen');
});

test('release only removes a lock we still own', () => {
  const lock = acquireSyncLock();
  assert.ok(lock);
  // Someone else steals/overwrites the lock with their pid.
  writeFileSync(syncLockPath(), JSON.stringify({ pid: 999_999 }));
  lock?.release();
  // Our release must NOT delete a lock owned by another pid.
  assert.equal(existsSync(syncLockPath()), true);
});

test('release abstains once the holder has run past STALE_MS (may have been stolen)', () => {
  const lock = acquireSyncLock();
  assert.ok(lock);
  assert.equal(existsSync(syncLockPath()), true);
  // Jump the clock 31 minutes forward (STALE_MS = 30 min). The holder must now
  // treat its lock as possibly-stolen and NOT delete it — deleting could remove
  // a new owner's lock (the non-atomic check-then-delete TOCTOU).
  try {
    setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    lock?.release();
    assert.equal(
      existsSync(syncLockPath()),
      true,
      'overrun release must abstain from deleting',
    );
  } finally {
    setSystemTime();
  }
});

test('release abstains within the safety margin before STALE_MS (26 min < 30)', () => {
  const lock = acquireSyncLock();
  assert.ok(lock);
  // 26 min: under STALE_MS (30) but past STALE_MS - margin (25). The safety
  // margin must make release abstain here too, not just past 30 min — so a
  // late-but-not-yet-stale holder can't delete a lock about to be stolen.
  try {
    setSystemTime(new Date(Date.now() + 26 * 60 * 1000));
    lock?.release();
    assert.equal(
      existsSync(syncLockPath()),
      true,
      'release within the safety margin must abstain',
    );
  } finally {
    setSystemTime();
  }
});

test('pruneProjectMap drops mappings whose remote id is gone, keeps the rest', () => {
  recordProjectMapping('test', '/work/alpha', 'remoteAAA');
  recordProjectMapping('test', '/work/beta', 'remoteBBB');
  recordProjectMapping('test', '/work/gamma', 'remoteCCC');

  const dropped = pruneProjectMap('test', new Set(['remoteAAA', 'remoteCCC']));
  assert.deepEqual(dropped, ['remoteBBB']);

  assert.equal(lookupRemoteProjectId('test', '/work/alpha'), 'remoteAAA');
  assert.equal(lookupRemoteProjectId('test', '/work/beta'), undefined);
  assert.equal(lookupRemoteProjectId('test', '/work/gamma'), 'remoteCCC');
});

test('pruneProjectMap with a fully-valid set changes nothing', () => {
  recordProjectMapping('test', '/work/alpha', 'remoteAAA');
  const dropped = pruneProjectMap('test', new Set(['remoteAAA']));
  assert.deepEqual(dropped, []);
  assert.equal(lookupRemoteProjectId('test', '/work/alpha'), 'remoteAAA');
});
