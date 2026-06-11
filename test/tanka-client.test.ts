import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRef } from '../src/discovery/sessions';
import {
  resolveBaseUrl,
  TokenExpiredError,
  testConnection,
  uploadSession,
} from '../src/upload/tanka-client';

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
let home: string;
let txnPath: string;

const TEST_URLS: Record<string, string> = {
  TANKA_API_URL_DEV: 'https://dev.example.com',
  TANKA_API_URL_TEST: 'https://test.example.com',
  TANKA_API_URL_UAT: 'https://uat.example.com',
  TANKA_API_URL_PROD: 'https://prod.example.com',
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-tanka-'));
  txnPath = join(home, 'transcript.jsonl');
  writeFileSync(txnPath, '{"hello":"world"}\n');
  for (const [k, v] of Object.entries(TEST_URLS)) process.env[k] = v;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
  for (const k of Object.keys(TEST_URLS)) delete process.env[k];
});

function makeRef(): SessionRef {
  return {
    id: 'sess-1',
    agent: 'claude-code',
    path: txnPath,
    cwd: '/tmp/proj',
    sizeBytes: 18,
    mtimeMs: 1700000000000,
    meta: {},
    sidecarFiles: [],
  };
}

test('resolveBaseUrl reads each environment from its env var', () => {
  assert.equal(resolveBaseUrl('prod'), 'https://prod.example.com');
  assert.equal(resolveBaseUrl('dev'), 'https://dev.example.com');
  assert.equal(resolveBaseUrl('test'), 'https://test.example.com');
  assert.equal(resolveBaseUrl('uat'), 'https://uat.example.com');
});

test('resolveBaseUrl throws when the env var is missing', () => {
  delete process.env.TANKA_API_URL_PROD;
  assert.throws(() => resolveBaseUrl('prod'), /TANKA_API_URL_PROD/);
});

test('uploadSession applies once then PUTs each file, returns transcriptFileId', async () => {
  const calls: Call[] = [];
  globalThis.fetch = (async (
    url: unknown,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: init?.headers ?? {},
    });
    if (String(url).includes('/open/file/upload/application')) {
      const reqBody = JSON.parse(init.body!) as {
        files: Array<{ localId: string; fileName: string }>;
      };
      const files = reqBody.files.map((f, i) => ({
        fileId: `id${i}`,
        localId: f.localId,
        url: `https://files/${f.fileName}`,
        uploadUrl: `https://s3.put/${f.localId}`,
      }));
      return new Response(
        JSON.stringify({ code: 0, msg: 'success', data: { files } }),
        { status: 200 },
      );
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const out = await uploadSession(
    'tok',
    'prod',
    makeRef(),
    () => {},
    'R00000000001',
  );
  assert.equal(out.fileCount, 1); // transcript only (no wmmeta)
  assert.equal(out.transcriptFileId, 'id0');
  assert.ok(out.transcriptUrl.includes('files/'));
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0]!.relPath, 'transcript.jsonl');

  const apply = calls.find((c) => c.url.includes('/application'))!;
  assert.equal(apply.method, 'POST');
  assert.equal(apply.headers.token, 'tok');
  const applied = JSON.parse(apply.body!) as {
    files: Array<{ module: string; groupId: string; contentMD5: string }>;
  };
  assert.equal(applied.files.length, 1);
  assert.ok(applied.files[0]!.groupId.startsWith('wm-session-R00000000001-'));
  assert.ok(applied.files[0]!.module === 'memory-work');
  assert.ok(
    applied.files.every(
      (f) => typeof f.contentMD5 === 'string' && f.contentMD5.length > 0,
    ),
  );

  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.ok(puts.every((p) => typeof p.headers['Content-MD5'] === 'string'));
  assert.ok(
    puts.every((p) =>
      p.headers['Content-Disposition']?.startsWith('attachment;filename='),
    ),
  );
});

test('uploadSession uploads OpenCode generated JSON transcript', async () => {
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const dbPath = join(home, 'opencode.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    `);
    db.query(
      'INSERT INTO session (id, directory, title, time_created, data) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'oc-1',
      cwd,
      'OpenCode upload',
      1_700_000_000_000,
      JSON.stringify({ model: 'test-model' }),
    );
    db.query('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
      'm1',
      'oc-1',
      JSON.stringify({ role: 'user' }),
    );
    db.query(
      'INSERT INTO part (id, session_id, message_id, data) VALUES (?, ?, ?, ?)',
    ).run(
      'p1',
      'oc-1',
      'm1',
      JSON.stringify({ type: 'text', text: 'upload me' }),
    );
  } finally {
    db.close();
  }

  const calls: Call[] = [];
  const putBodies: string[] = [];
  globalThis.fetch = (async (
    url: unknown,
    init: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: init?.headers ?? {},
    });
    if (String(url).includes('/open/file/upload/application')) {
      const reqBody = JSON.parse(String(init.body)) as {
        files: Array<{
          localId: string;
          fileName: string;
          contentType: string;
        }>;
      };
      assert.equal(reqBody.files[0]!.localId, 'transcript.json');
      assert.equal(reqBody.files[0]!.contentType, 'application/json');
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            files: reqBody.files.map((f, i) => ({
              fileId: `id${i}`,
              localId: f.localId,
              url: `https://files/${f.fileName}`,
              uploadUrl: `https://s3.put/${f.localId}`,
            })),
          },
        }),
        { status: 200 },
      );
    }
    if (init?.body instanceof Buffer)
      putBodies.push(init.body.toString('utf8'));
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const ref: SessionRef = {
    id: 'oc-1',
    agent: 'opencode',
    path: dbPath,
    cwd,
    sizeBytes: 123,
    mtimeMs: 1_700_000_000_000,
    meta: {},
    sidecarFiles: [],
    transcript: { kind: 'opencode', dbPath, sessionId: 'oc-1' },
  };
  const out = await uploadSession('tok', 'prod', ref, () => {}, 'R00000000001');

  assert.equal(out.fileCount, 1);
  assert.equal(out.files[0]!.relPath, 'transcript.json');
  assert.equal(out.transcriptFileId, 'id0');
  assert.equal(putBodies.length, 1);
  const uploaded = JSON.parse(putBodies[0]!) as {
    info: { id: string; title: string };
    messages: Array<{ parts: Array<{ text?: string }> }>;
  };
  assert.equal(uploaded.info.id, 'oc-1');
  assert.equal(uploaded.info.title, 'OpenCode upload');
  assert.equal(uploaded.messages[0]!.parts[0]!.text, 'upload me');
  assert.ok(calls.some((c) => c.url === 'https://s3.put/transcript.json'));
});

test('uploadSession uploads sidecar files and returns them keyed by relPath', async () => {
  const sidecarPath = join(home, 'agent-a1.jsonl');
  writeFileSync(sidecarPath, '{"sub":"agent"}\n');

  globalThis.fetch = (async (
    url: unknown,
    init: { method?: string; body?: string },
  ) => {
    if (String(url).includes('/open/file/upload/application')) {
      const reqBody = JSON.parse(init.body!) as {
        files: Array<{ localId: string; fileName: string }>;
      };
      const files = reqBody.files.map((f, i) => ({
        fileId: `id${i}`,
        localId: f.localId,
        url: `https://files/${f.fileName}`,
        uploadUrl: `https://s3.put/${f.localId}`,
      }));
      return new Response(
        JSON.stringify({ code: 0, msg: 'success', data: { files } }),
        { status: 200 },
      );
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const ref: SessionRef = {
    ...makeRef(),
    sidecarFiles: [
      {
        relPath: 'subagents/agent-a1.jsonl',
        absPath: sidecarPath,
        sizeBytes: 16,
        mtimeMs: 1700000000001,
      },
    ],
  };
  const out = await uploadSession('tok', 'prod', ref, () => {}, 'R00000000001');

  assert.equal(out.fileCount, 2); // transcript + 1 sidecar
  assert.equal(out.files.length, 2);
  const relPaths = out.files.map((f) => f.relPath).sort();
  assert.deepEqual(relPaths, ['subagents/agent-a1.jsonl', 'transcript.jsonl']);
  // transcript fileId resolves correctly even when not first
  assert.equal(
    out.transcriptFileId,
    out.files.find((f) => f.relPath === 'transcript.jsonl')!.fileId,
  );
});

test('uploadSession throws TokenExpiredError on 401', async () => {
  globalThis.fetch = (async () =>
    new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    uploadSession('bad', 'prod', makeRef(), () => {}, 'R00000000001'),
    TokenExpiredError,
  );
});

test('uploadSession surfaces a business error (code != 0)', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 1, msg: 'quota exceeded' }), {
      status: 200,
    })) as unknown as typeof fetch;
  await assert.rejects(
    uploadSession('tok', 'prod', makeRef(), () => {}, 'R00000000001'),
    /quota exceeded/,
  );
});

test('testConnection rejects on 401 and resolves on code 0', async () => {
  globalThis.fetch = (async () =>
    new Response('nope', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(testConnection('bad', 'prod'), TokenExpiredError);

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          files: [
            {
              uploadUrl: 'x',
              localId: 'connectivity-probe',
              fileId: 'f',
              url: 'u',
            },
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  await testConnection('good', 'prod');
});
