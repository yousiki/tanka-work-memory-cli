import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  exportOpenCodeTranscript,
  scanOpenCodeCwds,
} from '../src/discovery/opencode';
import {
  discoverSessionsForProject,
  primaryTranscriptRelPath,
  readPrimaryTranscriptBuffer,
} from '../src/discovery/sessions';
import { syncAgent } from '../src/sync';

let root: string;
let oldOpenCodeDb: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wm-opencode-'));
  oldOpenCodeDb = process.env.OPENCODE_DB;
});

afterEach(() => {
  if (oldOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = oldOpenCodeDb;
  rmSync(root, { recursive: true, force: true });
});

function createOpenCodeDb(dbPath: string, cwd: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        path TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        message_id TEXT,
        time_created INTEGER,
        data TEXT
      );
    `);
    db.query(
      `INSERT INTO session (id, project_id, directory, path, title, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sess-oc',
      'proj-1',
      cwd,
      '.',
      'OpenCode test',
      1_700_000_000_000,
      1_700_000_005_000,
      JSON.stringify({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    );
    db.query(
      `INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`,
    ).run(
      'msg-1',
      'sess-oc',
      1_700_000_001_000,
      JSON.stringify({ role: 'user' }),
    );
    db.query(
      `INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'part-1',
      'sess-oc',
      'msg-1',
      1_700_000_001_100,
      JSON.stringify({ type: 'text', text: 'hello from opencode' }),
    );
    db.query(
      `INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)`,
    ).run('part-2', 'sess-oc', 'msg-1', 1_700_000_001_200, '{not json');
  } finally {
    db.close();
  }
}

test('discovers OpenCode sessions from OPENCODE_DB with exact cwd matching', () => {
  const cwd = join(root, 'project');
  const subdir = join(cwd, 'subdir');
  mkdirSync(subdir, { recursive: true });
  const dbPath = join(root, 'opencode.db');
  createOpenCodeDb(dbPath, cwd);
  process.env.OPENCODE_DB = dbPath;

  const refs = discoverSessionsForProject([cwd]).filter(
    (ref) => ref.agent === 'opencode',
  );
  assert.equal(refs.length, 1);
  const ref = refs[0]!;
  assert.equal(ref.id, 'sess-oc');
  assert.equal(ref.cwd, resolve(cwd));
  assert.equal(ref.path, resolve(dbPath));
  assert.equal(ref.meta.title, 'OpenCode test');
  assert.equal(ref.meta.model, 'claude-sonnet-4-6');
  assert.equal(ref.meta.provider, 'anthropic');
  assert.equal(primaryTranscriptRelPath(ref), 'transcript.json');

  const subdirRefs = discoverSessionsForProject([subdir]).filter(
    (ref) => ref.agent === 'opencode',
  );
  assert.deepEqual(subdirRefs, []);
});

test('syncAgent maps non-Claude agents distinctly and keeps Cowork as Claude Code', () => {
  assert.equal(syncAgent('opencode'), 'opencode');
  assert.equal(syncAgent('jcode'), 'jcode');
  assert.equal(syncAgent('codex'), 'codex');
  assert.equal(syncAgent('cowork'), 'claude-code');
});

test('scans OpenCode cwds and generates export-shaped transcript JSON', () => {
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
  const dbPath = join(root, 'opencode.db');
  createOpenCodeDb(dbPath, cwd);
  process.env.OPENCODE_DB = dbPath;

  const scanned = scanOpenCodeCwds();
  assert.deepEqual(scanned, [
    { cwd: resolve(cwd), agent: 'opencode', sessionCount: 1 },
  ]);

  const exported = exportOpenCodeTranscript(dbPath, 'sess-oc');
  const doc = JSON.parse(exported) as {
    info: { id: string; title: string };
    messages: Array<{ info: { id: string; role: string }; parts: unknown[] }>;
  };
  assert.equal(doc.info.id, 'sess-oc');
  assert.equal(doc.info.title, 'OpenCode test');
  assert.equal(doc.messages.length, 1);
  assert.equal(doc.messages[0]!.info.id, 'msg-1');
  assert.equal(doc.messages[0]!.info.role, 'user');
  assert.equal(doc.messages[0]!.parts.length, 2);
  assert.deepEqual(doc.messages[0]!.parts[1], {
    rawData: '{not json',
    id: 'part-2',
    session_id: 'sess-oc',
    message_id: 'msg-1',
    time_created: 1_700_000_001_200,
  });

  const ref = discoverSessionsForProject([cwd]).find(
    (session) => session.agent === 'opencode',
  )!;
  assert.deepEqual(
    JSON.parse(readPrimaryTranscriptBuffer(ref).toString('utf8')),
    doc,
  );
});
