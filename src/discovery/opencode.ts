import { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ScannedCwd, SessionRef } from './sessions';

interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

interface TableInfo {
  table: string;
  columns: Map<string, string>;
}

interface DbShape {
  session: TableInfo;
  message?: TableInfo;
  part?: TableInfo;
}

interface SessionRow {
  id: string;
  cwdCandidates: string[];
  info: Record<string, unknown>;
  meta: Record<string, string>;
  mtimeMs: number;
  sizeBytes: number;
}

interface ExportMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

const TOP_LEVEL_DB = /^opencode(?:-[^.]+)?\.(?:db|sqlite|sqlite3)$/i;
const DB_FILE = /\.(?:db|sqlite|sqlite3)$/i;
const JOURNAL_FILE = /(?:-wal|-shm|-journal)$/i;
const PROJECT_SCAN_DEPTH = 8;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pushUnique(out: string[], p: string): void {
  const abs = path.resolve(p);
  if (!out.includes(abs)) out.push(abs);
}

function dataRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === 'win32') {
    const userHome = env.USERPROFILE?.trim() || home;
    const roots = [path.join(userHome, '.local', 'share', 'opencode')];
    if (env.LOCALAPPDATA?.trim())
      roots.push(path.join(env.LOCALAPPDATA, 'opencode'));
    return roots;
  }
  const roots = [path.join(home, '.local', 'share', 'opencode')];
  if (env.XDG_DATA_HOME?.trim())
    roots.push(path.join(env.XDG_DATA_HOME, 'opencode'));
  return roots;
}

function collectDbFiles(root: string, out: string[], depth = 0): void {
  if (depth > PROJECT_SCAN_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectDbFiles(abs, out, depth + 1);
      continue;
    }
    if (st.isFile() && DB_FILE.test(entry) && !JOURNAL_FILE.test(entry)) {
      pushUnique(out, abs);
    }
  }
}

/** Candidate OpenCode SQLite DB files, in priority order. Exported for focused tests. */
export function openCodeDbCandidates(opts: CandidateOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const out: string[] = [];

  const explicit = env.OPENCODE_DB?.trim();
  if (explicit && explicit !== ':memory:' && isFile(explicit))
    pushUnique(out, explicit);

  for (const root of dataRoots(platform, env, home)) {
    if (!isDir(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const abs = path.join(root, entry);
      if (TOP_LEVEL_DB.test(entry) && isFile(abs)) pushUnique(out, abs);
    }
    const projectRoot = path.join(root, 'project');
    if (isDir(projectRoot)) collectDbFiles(projectRoot, out);
  }

  return out;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTable(tables: string[], names: string[]): string | undefined {
  const wanted = new Set(names.map(normalizeName));
  return tables.find((t) => wanted.has(normalizeName(t)));
}

function columnMap(db: Database, table: string): Map<string, string> {
  const rows = db
    .query(`PRAGMA table_info(${quoteIdent(table)})`)
    .all() as Array<{
    name?: unknown;
  }>;
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name === 'string')
      out.set(normalizeName(row.name), row.name);
  }
  return out;
}

function pick(
  columns: Map<string, string>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const hit = columns.get(normalizeName(name));
    if (hit) return hit;
  }
  return undefined;
}

function dbShape(db: Database): DbShape | null {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{
    name?: unknown;
  }>;
  const tableNames = tables
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter(Boolean);
  const sessionTable = findTable(tableNames, [
    'session',
    'sessions',
    'session_table',
    'sessiontable',
  ]);
  if (!sessionTable) return null;
  const session = { table: sessionTable, columns: columnMap(db, sessionTable) };
  if (!pick(session.columns, ['id', 'session_id', 'sessionid'])) return null;

  const messageTable = findTable(tableNames, [
    'message',
    'messages',
    'message_table',
    'messagetable',
  ]);
  const partTable = findTable(tableNames, [
    'part',
    'parts',
    'part_table',
    'parttable',
  ]);
  return {
    session,
    message: messageTable
      ? { table: messageTable, columns: columnMap(db, messageTable) }
      : undefined,
    part: partTable
      ? { table: partTable, columns: columnMap(db, partTable) }
      : undefined,
  };
}

function selectRows(
  db: Database,
  table: TableInfo,
  where?: { column: string; value: unknown },
  orderColumns: string[] = [],
): Array<Record<string, unknown>> {
  const cols = [...new Set(table.columns.values())];
  if (cols.length === 0) return [];
  const sql = [
    `SELECT ${cols.map((c) => `${quoteIdent(c)} AS ${quoteIdent(c)}`).join(', ')}`,
    `FROM ${quoteIdent(table.table)}`,
  ];
  if (where) sql.push(`WHERE ${quoteIdent(where.column)} = ?`);
  const orders = orderColumns.filter((c) =>
    table.columns.has(normalizeName(c)),
  );
  if (orders.length > 0)
    sql.push(
      `ORDER BY ${orders.map((c) => quoteIdent(pick(table.columns, [c]) ?? c)).join(', ')}`,
    );
  const query = db.query(sql.join(' '));
  if (!where) return query.all() as Array<Record<string, unknown>>;
  const value = where.value;
  if (
    !(
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean' ||
      value instanceof Uint8Array
    )
  ) {
    return [];
  }
  return query.all(value) as Array<Record<string, unknown>>;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function setMeta(
  meta: Record<string, string>,
  key: string,
  value: unknown,
): void {
  const s = scalarString(value);
  if (s && !(key in meta)) meta[key] = s;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { rawData: value };
  }
}

function rowObject(
  row: Record<string, unknown>,
  dataColumn?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parsed = dataColumn ? parseJsonObject(row[dataColumn]) : {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v;
  for (const [k, v] of Object.entries(row)) {
    if (k === dataColumn || v === undefined || v === null) continue;
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function millis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return millis(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function iso(value: unknown): string | undefined {
  const ms = millis(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function byteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(JSON.stringify(value));
}

function pathCandidates(info: Record<string, unknown>): string[] {
  const out: string[] = [];
  const directory =
    typeof info.directory === 'string' ? info.directory : undefined;
  const sessionPath = typeof info.path === 'string' ? info.path : undefined;
  if (directory && path.isAbsolute(directory))
    out.push(path.resolve(directory));
  if (sessionPath && path.isAbsolute(sessionPath))
    out.push(path.resolve(sessionPath));
  if (directory && sessionPath && !path.isAbsolute(sessionPath)) {
    out.push(path.resolve(directory, sessionPath));
  }
  return [...new Set(out)];
}

function sessionRows(
  db: Database,
  shape: DbShape,
  dbMtimeMs: number,
): SessionRow[] {
  const table = shape.session;
  const idColumn = pick(table.columns, ['id', 'session_id', 'sessionid']);
  if (!idColumn) return [];
  const dataColumn = pick(table.columns, ['data', 'json', 'info']);
  const rows = selectRows(db, table, undefined, [
    'time_updated',
    'time_created',
    'id',
  ]);

  return rows.flatMap((row): SessionRow[] => {
    const id = scalarString(row[idColumn]);
    if (!id) return [];
    const info = rowObject(row, dataColumn);
    const meta: Record<string, string> = {};
    setMeta(meta, 'title', info.title);
    setMeta(
      meta,
      'projectId',
      info.project_id ?? info.projectID ?? info.projectId,
    );
    setMeta(meta, 'model', info.model ?? info.modelID ?? info.model_id);
    setMeta(
      meta,
      'provider',
      info.provider ?? info.providerID ?? info.provider_id,
    );
    setMeta(
      meta,
      'startedAt',
      iso(info.time_created ?? info.timeCreated ?? info.createdAt),
    );
    setMeta(
      meta,
      'updatedAt',
      iso(info.time_updated ?? info.timeUpdated ?? info.updatedAt),
    );

    const created = millis(
      info.time_created ?? info.timeCreated ?? info.createdAt,
    );
    const updated = millis(
      info.time_updated ?? info.timeUpdated ?? info.updatedAt,
    );
    const mtimeMs = Math.max(updated ?? 0, created ?? 0, dbMtimeMs);
    const sizeBytes = Object.values(row).reduce<number>(
      (sum, v) => sum + byteLength(v),
      0,
    );

    return [
      {
        id,
        cwdCandidates: pathCandidates(info),
        info,
        meta,
        mtimeMs,
        sizeBytes,
      },
    ];
  });
}

function rowsForSession(
  db: Database,
  table: TableInfo | undefined,
  sessionId: string,
): Array<Record<string, unknown>> {
  if (!table) return [];
  const sessionColumn = pick(table.columns, [
    'session_id',
    'sessionid',
    'session',
  ]);
  if (!sessionColumn) return [];
  return selectRows(db, table, { column: sessionColumn, value: sessionId }, [
    'time_created',
    'time_updated',
    'id',
  ]);
}

function partsForMessage(
  db: Database,
  table: TableInfo | undefined,
  messageId: unknown,
): Array<Record<string, unknown>> {
  if (!table || messageId === undefined || messageId === null) return [];
  const messageColumn = pick(table.columns, [
    'message_id',
    'messageid',
    'message',
  ]);
  if (!messageColumn) return [];
  return selectRows(db, table, { column: messageColumn, value: messageId }, [
    'time_created',
    'time_updated',
    'id',
  ]);
}

function summarizeSession(
  db: Database,
  shape: DbShape,
  session: SessionRow,
): SessionRow {
  const messages = rowsForSession(db, shape.message, session.id);
  const parts = rowsForSession(db, shape.part, session.id);
  let sizeBytes = session.sizeBytes;
  let mtimeMs = session.mtimeMs;
  for (const row of [...messages, ...parts]) {
    for (const value of Object.values(row)) sizeBytes += byteLength(value);
    for (const key of [
      'time_updated',
      'timeUpdated',
      'updatedAt',
      'time_created',
      'timeCreated',
      'createdAt',
    ]) {
      const ms = millis(row[key]);
      if (ms !== undefined) mtimeMs = Math.max(mtimeMs, ms);
    }
  }
  return { ...session, sizeBytes, mtimeMs };
}

function refsFromDb(
  dbPath: string,
  roots: readonly string[],
  exactCwdMatch: (
    candidate: string | undefined,
    roots: readonly string[],
  ) => boolean,
): SessionRef[] {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dbPath);
  } catch {
    return [];
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const shape = dbShape(db);
    if (!shape) return [];
    const out: SessionRef[] = [];
    for (const rawSession of sessionRows(db, shape, st.mtimeMs)) {
      const matched = rawSession.cwdCandidates.find((c) =>
        exactCwdMatch(c, roots),
      );
      if (!matched) continue;
      const session = summarizeSession(db, shape, rawSession);
      out.push({
        id: session.id,
        agent: 'opencode',
        path: dbPath,
        cwd: path.resolve(matched),
        sizeBytes: Math.max(1, session.sizeBytes),
        mtimeMs: session.mtimeMs,
        meta: { ...session.meta, dbPath },
        sidecarFiles: [],
        transcript: { kind: 'opencode', dbPath, sessionId: session.id },
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function discoverOpenCodeSessions(
  roots: readonly string[],
  exactCwdMatch: (
    candidate: string | undefined,
    roots: readonly string[],
  ) => boolean,
): SessionRef[] {
  const out: SessionRef[] = [];
  const seen = new Set<string>();
  for (const dbPath of openCodeDbCandidates()) {
    for (const ref of refsFromDb(dbPath, roots, exactCwdMatch)) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}

export function scanOpenCodeCwds(): ScannedCwd[] {
  const counts = new Map<string, number>();
  for (const dbPath of openCodeDbCandidates()) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dbPath);
    } catch {
      continue;
    }
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const shape = dbShape(db);
      if (!shape) continue;
      for (const session of sessionRows(db, shape, st.mtimeMs)) {
        const cwd = session.cwdCandidates[0];
        if (!cwd) continue;
        counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
      }
    } catch {
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return [...counts].map(([cwd, sessionCount]) => ({
    cwd,
    agent: 'opencode',
    sessionCount,
  }));
}

function exportMessages(
  db: Database,
  shape: DbShape,
  sessionId: string,
): ExportMessage[] {
  const messageTable = shape.message;
  const partTable = shape.part;
  const messages = rowsForSession(db, messageTable, sessionId);
  const messageDataColumn = messageTable
    ? pick(messageTable.columns, ['data', 'json', 'info'])
    : undefined;
  const partDataColumn = partTable
    ? pick(partTable.columns, ['data', 'json', 'info'])
    : undefined;
  const partMessageColumn = partTable
    ? pick(partTable.columns, ['message_id', 'messageid', 'message'])
    : undefined;
  const partsByMessage = new Map<string, Array<Record<string, unknown>>>();

  if (partTable && partMessageColumn) {
    for (const part of rowsForSession(db, partTable, sessionId)) {
      const messageId = scalarString(part[partMessageColumn]);
      if (!messageId) continue;
      let list = partsByMessage.get(messageId);
      if (!list) {
        list = [];
        partsByMessage.set(messageId, list);
      }
      list.push(part);
    }
  }

  return messages.map((message) => {
    const messageIdColumn = messageTable
      ? pick(messageTable.columns, ['id', 'message_id', 'messageid'])
      : undefined;
    const messageId = messageIdColumn
      ? scalarString(message[messageIdColumn])
      : undefined;
    const rawParts = messageId
      ? (partsByMessage.get(messageId) ??
        partsForMessage(db, partTable, messageId))
      : [];
    return {
      info: rowObject(message, messageDataColumn),
      parts: rawParts.map((part) => rowObject(part, partDataColumn)),
    };
  });
}

export function exportOpenCodeTranscript(
  dbPath: string,
  sessionId: string,
): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const shape = dbShape(db);
    if (!shape)
      throw new Error(`OpenCode database has no session table: ${dbPath}`);
    const idColumn = pick(shape.session.columns, [
      'id',
      'session_id',
      'sessionid',
    ]);
    if (!idColumn)
      throw new Error(`OpenCode database has no session id column: ${dbPath}`);
    const rows = selectRows(
      db,
      shape.session,
      { column: idColumn, value: sessionId },
      ['id'],
    );
    const row = rows[0];
    if (!row) throw new Error(`OpenCode session not found: ${sessionId}`);
    const dataColumn = pick(shape.session.columns, ['data', 'json', 'info']);
    const doc = {
      info: rowObject(row, dataColumn),
      messages: exportMessages(db, shape, sessionId),
    };
    return `${JSON.stringify(doc, null, 2)}\n`;
  } finally {
    db.close();
  }
}
