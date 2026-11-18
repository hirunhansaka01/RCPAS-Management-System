import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSql, execute, query } from './db.js';

/** Locates the migrations folder across environments. Locally (and on Vercel, where
 *  `includeFiles` places them at a project-root-relative path) it lives under cwd; the
 *  remaining candidates cover a flattened function bundle so a missing path fails loudly
 *  with every location tried instead of crashing the cold start with a bare ENOENT. */
async function resolveMigrationsDir(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), 'src/server/migrations'),
    path.join(process.cwd(), 'migrations'),
    path.join(process.cwd(), 'dist/server/migrations'),
    path.join(here, 'migrations'),
  ];
  for (const dir of candidates) {
    try { await fs.access(dir); return dir; } catch { /* try next */ }
  }
  throw new Error(`Migrations directory not found. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`);
}

/**
 * 0003 and 0004 both rebuild `event_equipment_requirements`, and both shipped
 * before migration tracking existed, so the live database has already run them
 * to completion. Re-running either one now is destructive rather than
 * idempotent:
 *
 *  - 0003 rebuilds the table into its pre-0004 shape (event_id, equipment_id,
 *    quantity), discarding the description, priority, notes and waiver columns
 *    0004 added along with every requirement row behind them. Its INSERT is
 *    refused first, because 0004 deliberately made `equipment_id` optional so a
 *    requirement can exist before anyone owns the gear — so the file aborts
 *    mid-way, leaves the database unprovisioned, and would drop the table if
 *    that guard were ever relaxed.
 *
 *  - 0004 would rebuild it again from its own output, regenerating each
 *    description from the equipment's brand and model. A hand-written
 *    "70-200mm lens" becomes "Equipment requirement", and priority, notes and
 *    waivers reset to their defaults.
 *
 * `description` can only exist if 0004 finished, and this runner is sequential
 * and aborts on the first error, so 0004 finishing proves 0003 finished too.
 * When the column is present both files are frozen as already applied without
 * executing a single statement. On a database that predates them the column is
 * absent and both run normally.
 */
/** True once 0004 has rebuilt `event_equipment_requirements` into its final shape.
 *  `description` exists only in that shape — 0001 defines the table as
 *  (event_id, equipment_id, quantity) with `equipment_id NOT NULL`, so a plain
 *  SELECT succeeding is conclusive proof that 0004 finished. A missing column or
 *  a missing table both throw, which is the expected answer on an older database. */
async function requirementsAreUpgraded(): Promise<boolean> {
  try {
    await query('SELECT description FROM event_equipment_requirements LIMIT 0');
    return true;
  } catch {
    return false;
  }
}

/** Files recognised from the live schema instead of being executed. */
const FROZEN_WHEN_UPGRADED = new Set(['0003_core_upgrade.sql', '0004_event_requirements_discussion.sql']);

/**
 * Applies the numbered .sql migrations idempotently. Safe to call on every cold
 * start: SQLite has no `ADD COLUMN IF NOT EXISTS`, so statements that fail only
 * because a column already exists are skipped rather than treated as errors.
 * Shared by the `pnpm db:migrate` CLI (migrate.ts) and the Vercel entrypoint
 * (vercel-app.ts), which must create the schema at boot because serverless has
 * no separate migrate step.
 */
export async function runMigrations(): Promise<{ count: number; skipped: number; files: number }> {
  const directory = await resolveMigrationsDir();
  const files = (await fs.readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  // A file is recorded only once every statement inside it has succeeded.
  //
  // Re-running a finished migration is not always a no-op, so idempotency alone is not
  // enough: 0004 rebuilds `event_equipment_requirements` from its own output, so a second
  // pass would overwrite the operator's free-text description with `brand || model` and
  // silently reset priority, notes and waivers. Skipping by name freezes a completed file.
  // To change one that has already shipped, add a new numbered migration rather than
  // editing it in place.
  await execSql('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = new Set((await query<{ name: string }[]>('SELECT name FROM schema_migrations')).map((row) => row.name));
  let count = 0;
  let skipped = 0;
  // Probed once, only if a frozen file is actually reached.
  let requirementsUpgraded: boolean | null = null;
  for (const file of files) {
    if (applied.has(file)) { skipped += 1; continue; }
    if (FROZEN_WHEN_UPGRADED.has(file)) {
      requirementsUpgraded ??= await requirementsAreUpgraded();
      if (requirementsUpgraded) {
        // Effects already present: freeze the file rather than run statements
        // that would rebuild the table backwards and lose requirement data.
        await execute('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', [file]);
        skipped += 1;
        continue;
      }
    }
    const migration = await fs.readFile(path.join(directory, file), 'utf8');
    const statements = migration.split(';').map((s) => s.trim()).filter(Boolean);
    for (const statement of statements) {
      try { await execSql(statement); count += 1; }
      catch (error) {
        const msg = String((error as Error)?.message ?? error);
        // Safe to skip when a migration re-runs on a live DB or when a remote libSQL server
        // (Turso) rejects a non-essential statement:
        //  - "duplicate column name" / "already exists" are expected on a second cold start.
        //  - PRAGMA statements are optimizations; Turso rejects some (e.g. foreign_keys) over
        //    HTTP, but they are not required for a correct schema.
        // Expected on a re-run: the object is already in place, so the statement is
        // a no-op rather than a failure. SQLite phrases the two cases differently -
        // "duplicate column name" / "already exists" for CREATE and ADD COLUMN, and
        // "there is already another table or index with this name" for a RENAME whose
        // target is taken (0003 swaps `events` via RENAME; a run that stopped after
        // the first half leaves `events_old` behind, and the next run must be able to
        // skip past it instead of aborting before the equipment search columns).
        if (/duplicate column name|already exists|already another table or index with this name/i.test(msg) || /^\s*PRAGMA\b/i.test(statement)) { skipped += 1; continue; }
        // Anything else is a real failure — name the file and statement so /api/health shows it.
        throw new Error(`Migration ${file} failed on: ${statement.slice(0, 160)} — ${msg}`);
      }
    }
    // Reached only when every statement applied or was safely skipped. A throw above
    // leaves the file unrecorded, so the next cold start retries it from the top.
    await execute('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)', [file]);
  }
  return { count, skipped, files: files.length };
}
