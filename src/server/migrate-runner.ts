import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSql } from './db.js';

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
  let count = 0;
  let skipped = 0;
  for (const file of files) {
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
        if (/duplicate column name|already exists/i.test(msg) || /^\s*PRAGMA\b/i.test(statement)) { skipped += 1; continue; }
        // Anything else is a real failure — name the file and statement so /api/health shows it.
        throw new Error(`Migration ${file} failed on: ${statement.slice(0, 160)} — ${msg}`);
      }
    }
  }
  return { count, skipped, files: files.length };
}
