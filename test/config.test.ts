import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configExists,
  emptyConfig,
  ensureProjectsEnv,
  loadConfig,
  loadCredentials,
  projectForCwd,
  projectsForEnv,
  saveConfig,
  saveCredentials,
  type TankaEnv,
} from '../src/config/config';
import {
  configPath,
  credentialsPath,
  projectManifestPath,
} from '../src/config/paths';
import {
  isUploaded,
  loadManifest,
  pruneManifest,
  recordUpload,
  type UploadRecord,
} from '../src/config/uploads';

const ENV: TankaEnv = 'test';

const rec = (projectId: string, sessionId: string): UploadRecord => ({
  projectId,
  sessionId,
  agent: 'claude-code',
  uploadedAt: '2026-06-01T00:00:00.000Z',
  fileCount: 3,
  sizeBytes: 1234,
  transcriptMtimeMs: 1700000000000,
  transcriptSizeBytes: 999,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wm-tui-cfg-'));
  process.env.TANKA_WM_HOME = home;
});
afterEach(() => {
  delete process.env.TANKA_WM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('config does not exist on a fresh home, then round-trips', () => {
  assert.equal(configExists(), false);
  assert.deepEqual(loadConfig(), emptyConfig());

  const cfg = {
    version: 1 as const,
    cwds: [{ id: 'demo', name: 'Demo', cwd: '/tmp/a' }],
  };
  saveConfig(cfg);
  assert.equal(configExists(), true);
  assert.deepEqual(loadConfig(), cfg);
});

test('projects round-trip; projectForCwd finds a member within env, undefined when unassigned', () => {
  const cfg = {
    version: 1 as const,
    cwds: [
      { id: 'a', name: 'A', cwd: '/tmp/a' },
      { id: 'b', name: 'B', cwd: '/tmp/b' },
      { id: 'c', name: 'C', cwd: '/tmp/c' },
    ],
    projects: [
      {
        id: 'a',
        remoteProjectId: 'R00000000001',
        name: 'A',
        cwdIds: ['a', 'b'],
        origin: 'created' as const,
        env: ENV,
      },
    ],
  };
  saveConfig(cfg);
  const loaded = loadConfig();
  assert.deepEqual(loaded, cfg);
  assert.equal(projectForCwd(loaded, 'a', ENV)?.id, 'a');
  assert.equal(projectForCwd(loaded, 'b', ENV)?.id, 'a');
  assert.equal(projectForCwd(loaded, 'c', ENV), undefined);
  // a different env sees nothing
  assert.equal(projectForCwd(loaded, 'a', 'prod'), undefined);
});

test('loadConfig drops malformed project entries and omits an empty projects key', () => {
  writeFileSync(
    configPath(),
    JSON.stringify({
      version: 1,
      cwds: [{ id: 'a', name: 'A', cwd: '/tmp/a' }],
      projects: [
        {
          id: 'g',
          remoteProjectId: 'R00000000001',
          name: 'G',
          cwdIds: ['a'],
          origin: 'created',
        },
        { id: 'bad', name: 'missing remoteProjectId', cwdIds: ['a'] },
        { id: 42, name: 'id not a string', cwdIds: [] },
      ],
    }),
  );
  const loaded = loadConfig();
  assert.equal(loaded.projects?.length, 1);
  assert.equal(loaded.projects?.[0]?.id, 'g');

  writeFileSync(
    configPath(),
    JSON.stringify({ version: 1, projects: [], groups: [{ bogus: true }] }),
  );
  assert.equal('projects' in loadConfig(), false);
});

test('credentials persist with 0600 permissions', () => {
  assert.equal(loadCredentials(), null);
  saveCredentials({ token: 'mcp_sk_demo', env: 'test' });
  assert.deepEqual(loadCredentials(), { token: 'mcp_sk_demo', env: 'test' });
  const mode = statSync(credentialsPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('pre-env credentials (token only) migrate to prod', () => {
  writeFileSync(credentialsPath(), JSON.stringify({ token: 'mcp_sk_old' }));
  assert.deepEqual(loadCredentials(), { token: 'mcp_sk_old', env: 'prod' });
});

test('an invalid env value falls back to prod', () => {
  writeFileSync(
    credentialsPath(),
    JSON.stringify({ token: 'mcp_sk_x', env: 'bogus' }),
  );
  assert.deepEqual(loadCredentials(), { token: 'mcp_sk_x', env: 'prod' });
});

test('a corrupt config file falls back to empty rather than throwing', () => {
  saveConfig(emptyConfig());
  saveCredentials({ token: 'x', env: 'prod' });
  rmSync(join(home, 'config.json'));
  assert.deepEqual(loadConfig(), emptyConfig());
});

test('upload manifest records and reports uploaded sessions', () => {
  let mf = loadManifest(ENV);
  assert.equal(isUploaded(mf, 'demo', 's1'), false);
  mf = recordUpload(ENV, mf, {
    projectId: 'demo',
    sessionId: 's1',
    agent: 'claude-code',
    uploadedAt: new Date().toISOString(),
    fileCount: 3,
    sizeBytes: 1234,
    transcriptMtimeMs: 1700000000000,
    transcriptSizeBytes: 999,
  });
  assert.equal(isUploaded(mf, 'demo', 's1'), true);
  assert.equal(isUploaded(loadManifest(ENV), 'demo', 's1'), true);
  assert.equal(isUploaded(loadManifest(ENV), 'demo', 's2'), false);
});

test('manifest is sharded per project under uploads/<env>/', () => {
  let mf = loadManifest(ENV);
  mf = recordUpload(ENV, mf, rec('omne-next', 's1'));
  mf = recordUpload(ENV, mf, rec('omne-next', 's2'));
  mf = recordUpload(ENV, mf, rec('other', 's3'));

  const omne = JSON.parse(
    readFileSync(projectManifestPath(ENV, 'omne-next'), 'utf8'),
  ) as Record<string, UploadRecord>;
  assert.deepEqual(Object.keys(omne).sort(), ['s1', 's2']);
  assert.equal(omne.s1?.sessionId, 's1');

  const other = JSON.parse(
    readFileSync(projectManifestPath(ENV, 'other'), 'utf8'),
  ) as Record<string, UploadRecord>;
  assert.deepEqual(Object.keys(other), ['s3']);

  const reloaded = loadManifest(ENV);
  assert.equal(isUploaded(reloaded, 'omne-next', 's1'), true);
  assert.equal(isUploaded(reloaded, 'omne-next', 's2'), true);
  assert.equal(isUploaded(reloaded, 'other', 's3'), true);
});

test('pruneManifest drops records for vanished sessions, scoped per project', () => {
  let mf = loadManifest(ENV);
  mf = recordUpload(ENV, mf, rec('omne-next', 's1'));
  mf = recordUpload(ENV, mf, rec('omne-next', 's2'));
  mf = recordUpload(ENV, mf, rec('other', 's3'));

  const { manifest: pruned, removed } = pruneManifest(
    ENV,
    mf,
    'omne-next',
    new Set(['s1']),
  );
  assert.equal(removed, 1);
  assert.equal(isUploaded(pruned, 'omne-next', 's1'), true);
  assert.equal(isUploaded(pruned, 'omne-next', 's2'), false);
  assert.equal(isUploaded(pruned, 'other', 's3'), true);

  const reloaded = loadManifest(ENV);
  assert.equal(isUploaded(reloaded, 'omne-next', 's1'), true);
  assert.equal(isUploaded(reloaded, 'omne-next', 's2'), false);
  assert.equal(isUploaded(reloaded, 'other', 's3'), true);

  const noop = pruneManifest(ENV, reloaded, 'omne-next', new Set(['s1']));
  assert.equal(noop.removed, 0);
  assert.equal(noop.manifest, reloaded);
});

test('pruning the last session in a project removes its shard file', () => {
  let mf = loadManifest(ENV);
  mf = recordUpload(ENV, mf, rec('solo', 'only'));
  assert.equal(existsSync(projectManifestPath(ENV, 'solo')), true);

  const { removed } = pruneManifest(ENV, mf, 'solo', new Set());
  assert.equal(removed, 1);
  assert.equal(existsSync(projectManifestPath(ENV, 'solo')), false);
});

// ─── env scoping tests ──────────────────────────────────────

test('projectsForEnv filters by env; legacy projects without env match current', () => {
  const cfg = {
    version: 1 as const,
    cwds: [{ id: 'a', name: 'A', cwd: '/tmp/a' }],
    projects: [
      {
        id: 'p1',
        remoteProjectId: 'R1',
        name: 'P1',
        cwdIds: ['a'],
        origin: 'created' as const,
        env: 'test' as const,
      },
      {
        id: 'p2',
        remoteProjectId: 'R2',
        name: 'P2',
        cwdIds: ['a'],
        origin: 'created' as const,
        env: 'prod' as const,
      },
      {
        id: 'p3',
        remoteProjectId: 'R3',
        name: 'P3',
        cwdIds: ['a'],
        origin: 'created' as const,
      },
    ],
  };
  const testProjects = projectsForEnv(cfg, 'test');
  assert.equal(testProjects.length, 2); // p1 + p3 (legacy treated as current)
  assert.ok(testProjects.some((p) => p.id === 'p1'));
  assert.ok(testProjects.some((p) => p.id === 'p3'));

  const prodProjects = projectsForEnv(cfg, 'prod');
  assert.equal(prodProjects.length, 2); // p2 + p3 (legacy treated as current)
  assert.ok(prodProjects.some((p) => p.id === 'p2'));
  assert.ok(prodProjects.some((p) => p.id === 'p3'));
});

test('ensureProjectsEnv backfills env on legacy projects and persists', () => {
  const cfg = {
    version: 1 as const,
    cwds: [],
    projects: [
      {
        id: 'p1',
        remoteProjectId: 'R1',
        name: 'P1',
        cwdIds: [],
        origin: 'created' as const,
      },
      {
        id: 'p2',
        remoteProjectId: 'R2',
        name: 'P2',
        cwdIds: [],
        origin: 'created' as const,
        env: 'prod' as const,
      },
    ],
  };
  saveConfig(cfg);
  const result = ensureProjectsEnv(cfg, 'test');
  assert.equal(result.projects?.[0]?.env, 'test');
  assert.equal(result.projects?.[1]?.env, 'prod'); // already set, not overwritten
  // persisted
  const reloaded = loadConfig();
  assert.equal(reloaded.projects?.[0]?.env, 'test');
  assert.equal(reloaded.projects?.[1]?.env, 'prod');
});

test('ensureProjectsEnv is a no-op when all projects already have env', () => {
  const cfg = {
    version: 1 as const,
    cwds: [],
    projects: [
      {
        id: 'p1',
        remoteProjectId: 'R1',
        name: 'P1',
        cwdIds: [],
        origin: 'created' as const,
        env: 'test' as const,
      },
    ],
  };
  const result = ensureProjectsEnv(cfg, 'test');
  assert.equal(result, cfg); // same reference — no write
});

test('manifest env isolation: test and prod manifests are independent', () => {
  let testMf = loadManifest('test');
  testMf = recordUpload('test', testMf, rec('proj', 's1'));
  assert.equal(isUploaded(testMf, 'proj', 's1'), true);

  // prod manifest should be empty
  const prodMf = loadManifest('prod');
  assert.equal(isUploaded(prodMf, 'proj', 's1'), false);
});

test('loadConfig normalizes invalid env on projects (drops bad value, keeps project)', () => {
  writeFileSync(
    configPath(),
    JSON.stringify({
      version: 1,
      cwds: [],
      projects: [
        {
          id: 'p',
          remoteProjectId: 'R1',
          name: 'P',
          cwdIds: [],
          origin: 'created',
          env: 'BOGUS',
        },
      ],
    }),
  );
  const loaded = loadConfig();
  assert.equal(loaded.projects?.length, 1);
  assert.equal(loaded.projects?.[0]?.env, undefined); // bad env dropped, project kept
});
