import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Config,
  remapConfigProject,
  type TankaEnv,
} from '../src/config/config';
import { projectManifestPath } from '../src/config/paths';
import {
  loadProjectMap,
  remapProjectId,
  saveProjectMap,
} from '../src/config/project-map';
import {
  loadManifest,
  migrateProjectManifest,
  recordUpload,
  type UploadRecord,
} from '../src/config/uploads';
import type { SessionRef } from '../src/discovery/sessions';
import { allModeItems, selectModeItems } from '../src/project-items';

const ENV: TankaEnv = 'test';

const rec = (
  projectId: string,
  sessionId: string,
  transcriptMtimeMs = 1700000000000,
): UploadRecord => ({
  projectId,
  sessionId,
  agent: 'claude-code',
  uploadedAt: '2026-06-01T00:00:00.000Z',
  fileCount: 3,
  sizeBytes: 1234,
  transcriptMtimeMs,
  transcriptSizeBytes: 999,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-tui-mig-'));
  process.env.TANKA_WM_HOME = home;
});
afterEach(() => {
  delete process.env.TANKA_WM_HOME;
  rmSync(home, { recursive: true, force: true });
});

// ─── manifest migration ─────────────────────────────────────

test('migrateProjectManifest moves records into the target namespace and drops the source shard', () => {
  let m = loadManifest(ENV);
  m = recordUpload(ENV, m, rec('src', 's1'));
  m = recordUpload(ENV, m, rec('src', 's2'));
  recordUpload(ENV, m, rec('other', 's3'));

  const moved = migrateProjectManifest(ENV, 'src', 'dst');
  assert.equal(moved, 2);
  assert.equal(existsSync(projectManifestPath(ENV, 'src')), false);

  const after = loadManifest(ENV);
  assert.deepEqual(Object.keys(after.entries).sort(), [
    'dst/s1',
    'dst/s2',
    'other/s3',
  ]);
  assert.equal(after.entries['dst/s1']?.projectId, 'dst');
});

test('migrateProjectManifest keeps the newer record on a sessionId collision', () => {
  let m = loadManifest(ENV);
  m = recordUpload(ENV, m, rec('src', 'shared', 2000));
  m = recordUpload(ENV, m, rec('dst', 'shared', 1000));
  m = recordUpload(ENV, m, rec('src', 'stale', 1000));
  recordUpload(ENV, m, rec('dst', 'stale', 2000));

  // Only 'shared' is actually written into the target ('stale' loses the
  // collision and is dropped) — the return value counts writes, not sources.
  assert.equal(migrateProjectManifest(ENV, 'src', 'dst'), 1);
  const after = loadManifest(ENV);
  assert.equal(after.entries['dst/shared']?.transcriptMtimeMs, 2000); // source won
  assert.equal(after.entries['dst/stale']?.transcriptMtimeMs, 2000); // target won
});

test('migrateProjectManifest is a no-op when the source namespace is empty', () => {
  recordUpload(ENV, loadManifest(ENV), rec('dst', 's1'));
  assert.equal(migrateProjectManifest(ENV, 'missing', 'dst'), 0);
  assert.deepEqual(Object.keys(loadManifest(ENV).entries), ['dst/s1']);
});

// ─── project-map remap (all mode) ───────────────────────────

test('remapProjectId re-points only the mappings of the source project', () => {
  saveProjectMap(ENV, { '/a': 'src', '/b': 'src', '/c': 'other' });
  assert.equal(remapProjectId(ENV, 'src', 'dst'), 2);
  assert.deepEqual(loadProjectMap(ENV), {
    '/a': 'dst',
    '/b': 'dst',
    '/c': 'other',
  });
  assert.equal(remapProjectId(ENV, 'src', 'dst'), 0);
});

// ─── config remap (select mode) ─────────────────────────────

const cfgWith = (projects: Config['projects']): Config => ({
  version: 1,
  cwds: [
    { id: 'a', name: 'A', cwd: '/tmp/a' },
    { id: 'b', name: 'B', cwd: '/tmp/b' },
  ],
  projects,
});

test('remapConfigProject rewrites the source entry when the target has no local project', () => {
  const cfg = cfgWith([
    {
      id: 'src',
      remoteProjectId: 'src',
      name: 'Src',
      cwdIds: ['a'],
      origin: 'created',
      env: ENV,
    },
  ]);
  const next = remapConfigProject(cfg, ENV, 'src', 'dst');
  assert.ok(next);
  assert.deepEqual(
    next.projects?.map((p) => [p.id, p.remoteProjectId, p.cwdIds]),
    [['dst', 'dst', ['a']]],
  );
});

test('remapConfigProject merges cwds into an existing target and drops the source', () => {
  const cfg = cfgWith([
    {
      id: 'src',
      remoteProjectId: 'src',
      name: 'Src',
      cwdIds: ['a'],
      origin: 'created',
      env: ENV,
    },
    {
      id: 'dst',
      remoteProjectId: 'dst',
      name: 'Dst',
      cwdIds: ['b'],
      origin: 'joined',
      env: ENV,
    },
  ]);
  const next = remapConfigProject(cfg, ENV, 'src', 'dst');
  assert.ok(next);
  assert.equal(next.projects?.length, 1);
  assert.deepEqual(next.projects?.[0]?.cwdIds.sort(), ['a', 'b']);
  assert.equal(next.projects?.[0]?.name, 'Dst');
});

// ─── shared project-item derivation ─────────────────────────

test('allModeItems groups refs per cwd with counts and project-map lookups', () => {
  saveProjectMap(ENV, { '/tmp/a': 'ridA' });
  const ref = (id: string, cwd: string): SessionRef => ({
    id,
    agent: 'claude-code',
    path: `/x/${id}.jsonl`,
    cwd,
    sizeBytes: 1,
    mtimeMs: 1,
    meta: {},
    sidecarFiles: [],
  });
  const items = allModeItems(
    [ref('s1', '/tmp/a'), ref('s2', '/tmp/a'), ref('s3', '/tmp/b')],
    ENV,
  );
  assert.deepEqual(
    items.map((it) => [it.name, it.remoteProjectId, it.sessions]),
    [
      ['a', 'ridA', 2],
      ['b', undefined, 1],
    ],
  );
  assert.equal(items[0]?.ns, 'ridA');
  assert.ok(items[1]?.ns); // never synced: ns falls back to the synthetic id
});

test('selectModeItems maps env projects to items with resolved cwd paths', () => {
  const items = selectModeItems(
    cfgWith([
      {
        id: 'p1',
        remoteProjectId: 'p1',
        name: 'P One',
        cwdIds: ['a', 'missing'],
        origin: 'created',
        env: ENV,
      },
    ]),
    ENV,
  );
  assert.deepEqual(
    items.map((it) => [it.name, it.ns, it.origin, it.cwdPaths]),
    [['P One', 'p1', 'created', ['/tmp/a']]],
  );
});

test('remapConfigProject leaves other envs alone and returns null without a source', () => {
  const cfg = cfgWith([
    {
      id: 'src',
      remoteProjectId: 'src',
      name: 'Src (prod)',
      cwdIds: ['a'],
      origin: 'created',
      env: 'prod',
    },
  ]);
  assert.equal(remapConfigProject(cfg, ENV, 'src', 'dst'), null);
  assert.equal(remapConfigProject(cfg, ENV, 'nope', 'dst'), null);
});
