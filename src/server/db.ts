import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createClient } from '@libsql/client/http';
import type { Client } from '@libsql/client';

// Load the local .env file when present (shell/OS variables always win).
try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); } catch { /* no .env file */ }

export interface ExecuteResult { insertId: number; affectedRows: number; changes: number; }

export interface SqlExecutor {
  query<T = any[]>(sql: string, params?: unknown[]): Promise<T>;
  /** Resolves to a tuple so callers can destructure `const [result] = await connection.execute(...)`.
   *  The type argument is accepted for mysql2 call-site compatibility (`execute<ResultSetHeader>`). */
  execute<T = any>(sql: string, params?: unknown[]): Promise<[ExecuteResult]>;
}

// ---------------------------------------------------------------------------
// Driver selection.
//   * Local/dev: a single SQLite file via node:sqlite (fast, no network).
//   * Durable/serverless: a remote Turso database via @libsql/client/http (pure
//     JS, no native binary). Vercel's filesystem is ephemeral, so pointing
//     TURSO_DATABASE_URL at a hosted database is what makes data survive cold
//     starts and redeploys. Absent these vars we keep the SQLite file, so local
//     development is unchanged.
// ---------------------------------------------------------------------------
/** Turso URLs are sometimes pasted without a scheme (bare host) or with stray quotes.
 *  Normalize the common forms so they still resolve; @libsql/client/http accepts
 *  libsql://, https:// and http://. A value that still fails to parse surfaces a clear
 *  error from getClient() rather than a bare "Invalid URL". */
function normalizeTursoUrl(raw: string): string {
  const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!cleaned) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `libsql://${cleaned}`;
}
const TURSO_URL = normalizeTursoUrl(process.env.TURSO_DATABASE_URL || process.env.LIBSQL_DATABASE_URL || '');
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '').trim();
/** True when a hosted libSQL/Turso database is configured instead of a local file. */
export const usingTurso = TURSO_URL.length > 0;

let tursoClient: Client | null = null;
function getClient(): Client {
  if (!tursoClient) {
    // Fail fast with an actionable message if the URL still can't be parsed (e.g. it is a
    // bare DB name like "rcpas" instead of the full host). The URL is a hostname, not a
    // credential, so echoing it is safe and helps pinpoint the typo.
    try { new URL(TURSO_URL); } catch {
      throw new Error(`TURSO_DATABASE_URL is not a valid URL (got "${TURSO_URL}"). Expected libsql://rcpas-<your-org>.turso.io — run \`turso db show rcpas\` and copy the "URL" value.`);
    }
    // intMode:'number' keeps INTEGER columns as JS numbers, matching node:sqlite
    // so the Express handlers can JSON-serialize them without a bigint crash.
    tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined, intMode: 'number' });
  }
  return tursoClient;
}

// Keeps the mysql2-shaped API (query/execute/withTransaction) on top of the selected driver.
let database: DatabaseSync | null = null;
const statements = new Map<string, StatementSync>();
let queue: Promise<unknown> = Promise.resolve();

function resolveFile(raw: string): string {
  const url = raw.trim();
  if (/^mysql:/i.test(url)) throw new Error('MySQL is no longer used. Set DATABASE_URL to a SQLite file path such as ./data/rcpas.sqlite');
  if (url.startsWith('file:')) return url.slice('file:'.length).replace(/^\/\//, '');
  if (url.startsWith('sqlite:')) return url.slice('sqlite:'.length);
  return url || './data/rcpas.sqlite';
}

/** On serverless (Vercel) the project dir is read-only and only /tmp is writable,
 *  so fall back to a /tmp SQLite file when the configured path cannot be opened.
 *  NOTE: /tmp is ephemeral — data resets on each cold start. A persistent host
 *  (such as Turso, see TURSO_DATABASE_URL above) is required for durable data. */
function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  try {
    return new DatabaseSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && ['EROFS', 'EACCES', 'EPERM', 'ENOTDIR'].includes(code)) {
      const fallback = path.join('/tmp', 'rcpas.sqlite');
      console.warn(`[db] "${file}" is not writable (${code}); falling back to ${fallback}. Data resets on cold start.`);
      fs.mkdirSync(path.dirname(fallback), { recursive: true });
      return new DatabaseSync(fallback);
    }
    throw error;
  }
}

/** Local-only raw handle. Exposed for the SQLite driver; not meaningful for Turso. */
export function getDb(): DatabaseSync {
  if (usingTurso) throw new Error('getDb() is unavailable when using Turso; use query()/execute() instead.');
  if (!database) {
    const file = resolveFile(process.env.DATABASE_URL || './data/rcpas.sqlite');
    database = openDatabase(file);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }
  return database;
}

export function closeDb(): void {
  if (usingTurso) {
    tursoClient?.close();
    tursoClient = null;
    return;
  }
  statements.clear();
  database?.close();
  database = null;
}

/** Dates are stored as UTC 'YYYY-MM-DD HH:MM:SS' text, matching the previous MySQL timezone:'Z' contract.
 *  Shared by both drivers so a row written via Turso is byte-identical to one written to a local file. */
function toParam(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  throw new Error(`Unsupported SQL parameter type: ${typeof value}`);
}

// --------------------------------------------------------------------------
// Local node:sqlite driver (unchanged behaviour).
// --------------------------------------------------------------------------
function prepare(sql: string): StatementSync {
  let statement = statements.get(sql);
  if (!statement) { statement = getDb().prepare(sql); statements.set(sql, statement); }
  return statement;
}

function runQuery<T>(sql: string, params: unknown[] = []): T {
  return prepare(sql).all(...(params.map(toParam) as any[])) as T;
}

function runExecute(sql: string, params: unknown[] = []): ExecuteResult {
  const info = prepare(sql).run(...(params.map(toParam) as any[]));
  const changes = Number(info.changes);
  return { insertId: Number(info.lastInsertRowid), affectedRows: changes, changes };
}

// --------------------------------------------------------------------------
// Remote Turso driver.
// --------------------------------------------------------------------------

/** @libsql returns column-oriented rows (numeric access + a length). Rebuild them as plain
 *  objects keyed by column name so results are byte-identical to node:sqlite's `.all()` and
 *  JSON-serialize cleanly (no stray numeric/length keys). */
function rowsToObjects<T>(rs: { columns: string[]; rows: ArrayLike<unknown>[] }): T {
  const names = rs.columns;
  return rs.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i += 1) obj[names[i]] = row[i];
    return obj;
  }) as unknown as T;
}

function toArgs(params: unknown[]): any[] {
  return params.map((p) => toParam(p) as any);
}

async function tursoQuery<T>(sql: string, params: unknown[] = []): Promise<T> {
  const rs = await getClient().execute({ sql, args: toArgs(params) });
  return rowsToObjects<T>(rs);
}

async function tursoExecute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
  const rs = await getClient().execute({ sql, args: toArgs(params) });
  const changes = rs.rowsAffected;
  return { insertId: Number(rs.lastInsertRowid ?? 0), affectedRows: changes, changes };
}

async function tursoExec(sql: string): Promise<void> {
  await getClient().execute({ sql, args: [] });
}

async function tursoTx<T>(fn: (connection: SqlExecutor) => Promise<T>): Promise<T> {
  const tx = await getClient().transaction();
  const connection: SqlExecutor = {
    query: async (sql, params = []) => rowsToObjects(await tx.execute({ sql, args: toArgs(params) })),
    execute: async (sql, params = []) => {
      const rs = await tx.execute({ sql, args: toArgs(params) });
      return [{ insertId: Number(rs.lastInsertRowid ?? 0), affectedRows: rs.rowsAffected, changes: rs.rowsAffected }];
    },
  };
  try {
    const result = await fn(connection);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Public mysql2-shaped API (unchanged signatures; dispatches by driver).
// --------------------------------------------------------------------------

// SQLite has a single writer, so every operation is serialized on one connection. Inside a
// transaction use the `connection` handed to your callback: calling query()/execute() from a
// withTransaction callback would deadlock on this queue. Turso also runs through the queue so
// transactions never overlap, keeping semantics identical across drivers.
function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.then(() => undefined, () => undefined);
  return task;
}

export async function query<T = any[]>(sql: string, params: unknown[] = []): Promise<T> {
  return serialize(async () => (usingTurso ? tursoQuery<T>(sql, params) : runQuery<T>(sql, params)));
}

export async function execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
  return serialize(async () => (usingTurso ? tursoExecute(sql, params) : runExecute(sql, params)));
}

/** Runs one or more parameter-less statements (PRAGMA, DDL) outside the prepared-statement cache. */
export async function execSql(sql: string): Promise<void> {
  return serialize(async () => {
    if (usingTurso) { await tursoExec(sql); return; }
    getDb().exec(sql);
  });
}

export async function withTransaction<T>(fn: (connection: SqlExecutor) => Promise<T>): Promise<T> {
  if (usingTurso) return serialize(() => tursoTx(fn));
  return serialize(async () => {
    const db = getDb();
    db.exec('BEGIN');
    try {
      const connection: SqlExecutor = {
        query: async (sql, params = []) => runQuery(sql, params),
        execute: async (sql, params = []) => [runExecute(sql, params)],
      };
      const result = await fn(connection);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  });
}
