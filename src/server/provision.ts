import { execute, query } from './db.js';
import { runMigrations } from './migrate-runner.js';
import { hashPassword } from './password.js';

// Reference data (roles, permissions, creative roles, equipment categories, role_permissions).
// Extracted from seed.ts so the same idempotent logic can run both from the CLI (`pnpm db:seed`)
// and at serverless cold start against a fresh database (e.g. a brand-new Turso DB on Vercel),
// which would otherwise boot with no roles/permissions and no way to log in.
const ROLES: Array<[string, string]> = [
  ['President', 'Society President'], ['Chief Organizer', 'Chief event and operations organizer'],
  ['Authorized Organizer', 'Approved organizer with scoped operational permissions'], ['System Administrator', 'Technical administrator; not automatically President'],
];
const PERMISSIONS = ['dashboard.view','members.read','members.write','members.register','members.export','contacts.read','creative.read','creative.write','equipment.read','equipment.write','equipment.allocate','events.read','events.write','assignments.read','assignments.write','assignments.override','reports.read','reports.export','settings.read','settings.write','users.manage','audit.read'];
// Restricted to System Administrator only unless explicitly configured later.
const ADMIN_ONLY_PERMISSIONS = new Set(['members.register']);
const CREATIVE_ROLES = ['Photographer','Photo Editor','Graphic Designer','Videographer','Social Media Creator','Event Organizer','Equipment Coordinator','Lead Photographer','Second Shooter','Other'];
const EQUIPMENT_CATEGORIES = ['Cameras','Lenses','Tripods','Flashes','Microphones','Lighting','Stabilizers','Drones','Memory Cards & Accessories','Other'];

/** Idempotently creates the reference tables and the role→permission matrix. Never replaces
 *  existing records (INSERT OR IGNORE throughout), so it is safe on every cold start. */
export async function seedReferenceData(): Promise<void> {
  // A populated database needs no seeding. Re-running every INSERT OR IGNORE on each
  // cold start cost 121 sequential round trips to Turso - about 40 seconds at the
  // observed per-trip latency - for zero effect, and it is why health reported a fresh
  // provisionedAt on every request. One round trip replaces all 121. If any table is
  // short (a partial seed, or a new row added to the arrays above), the full idempotent
  // path below runs and completes it, so nothing is ever silently skipped.
  const counts = await query<{ roles: number; perms: number; creative: number; categories: number; grants: number }[]>(
    'SELECT (SELECT COUNT(*) FROM system_roles) AS roles, (SELECT COUNT(*) FROM permissions) AS perms, (SELECT COUNT(*) FROM creative_roles) AS creative, (SELECT COUNT(*) FROM equipment_categories) AS categories, (SELECT COUNT(*) FROM role_permissions) AS grants'
  );
  const c = counts[0];
  if (c && c.roles >= ROLES.length && c.perms >= PERMISSIONS.length && c.creative >= CREATIVE_ROLES.length && c.categories >= EQUIPMENT_CATEGORIES.length && c.grants > 0) return;
  for (const [name, description] of ROLES) await execute('INSERT OR IGNORE INTO system_roles (name, description) VALUES (?, ?)', [name, description]);
  for (const code of PERMISSIONS) await execute('INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)', [code, code.replace('.', ' ')]);
  for (const name of CREATIVE_ROLES) await execute('INSERT OR IGNORE INTO creative_roles (name) VALUES (?)', [name]);
  for (const name of EQUIPMENT_CATEGORIES) await execute('INSERT OR IGNORE INTO equipment_categories (name) VALUES (?)', [name]);
  const roleMap = await query<{ id: number; name: string }[]>('SELECT id, name FROM system_roles');
  const permissionMap = await query<{ id: number; code: string }[]>('SELECT id, code FROM permissions');
  for (const role of roleMap) for (const permission of permissionMap) {
    const allowed = role.name === 'System Administrator'
      || (!ADMIN_ONLY_PERMISSIONS.has(permission.code) && (role.name === 'President' || (role.name === 'Chief Organizer' && !permission.code.startsWith('users.')) || (role.name === 'Authorized Organizer' && ['dashboard.view','members.read','members.write','members.export','contacts.read','creative.read','creative.write','equipment.read','equipment.write','equipment.allocate','events.read','events.write','assignments.read','assignments.write','reports.read','reports.export'].includes(permission.code))));
    if (allowed) await execute('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, permission.id]);
  }
}

/** Idempotently creates/updates the admin user (from SETUP_ADMIN_* env vars) and grants it the
 *  System Administrator role. Returns the admin email on success, or null when the env vars are
 *  absent (not an error — nothing to provision). By default an existing password is left alone so
 *  a cold start never overwrites a password the admin has since changed; pass
 *  `{ resetPassword: true }` (the `pnpm db:setup-admin` CLI) to force a reset. */
export async function ensureAdmin(options: { resetPassword?: boolean } = {}): Promise<string | null> {
  const email = process.env.SETUP_ADMIN_EMAIL?.trim();
  const password = process.env.SETUP_ADMIN_PASSWORD;
  if (!email || !password) return null;
  const openId = process.env.SETUP_ADMIN_OPEN_ID || `local:${email.toLowerCase()}`;
  const displayName = process.env.SETUP_ADMIN_NAME || email;
  await execute('INSERT INTO users (open_id, email, display_name, active) VALUES (?, ?, ?, 1) ON CONFLICT(open_id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name, active=1', [openId, email, displayName]);
  // One round trip instead of four: is a password already stored, and is the System
  // Administrator role granted? When both hold and no reset was asked for there is
  // nothing left to do - which is the normal case on every cold start after setup.
  const ready = await query<{ password_hash: string | null; grants: number }[]>(
    `SELECT u.password_hash,
       (SELECT COUNT(*) FROM user_roles ur JOIN system_roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.name='System Administrator') AS grants
     FROM users u WHERE u.open_id=?`, [openId]);
  if (ready[0] && ready[0].password_hash && ready[0].grants > 0 && !options.resetPassword) return email;
  const user = await query<{ id: number }[]>('SELECT id FROM users WHERE open_id=?', [openId]);
  const role = await query<{ id: number }[]>('SELECT id FROM system_roles WHERE name=?', ['System Administrator']);
  if (!user[0] || !role[0]) throw new Error('Run migrations and seedReferenceData() before ensureAdmin().');
  await execute('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [user[0].id, role[0].id]);
  if (options.resetPassword || !ready[0]?.password_hash) {
    await execute('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP WHERE id=?', [await hashPassword(password), user[0].id]);
  }
  return email;
}

/** Idempotent full bootstrap: schema → reference data → optional admin. Safe on every cold start;
 *  used by the serverless entrypoint so a fresh hosted database (Turso) is usable immediately.
 *  Migrations and reference data are fatal if they fail (the app is useless without them), but
 *  admin setup is best-effort: a bad SETUP_ADMIN_* value (e.g. a password under 12 chars) is
 *  logged rather than allowed to block the whole deploy. It can be re-run later with
 *  `pnpm db:setup-admin` pointed at the same database. */
export async function provisionDatabase(): Promise<{ migrations: number; files: number; admin: boolean }> {
  const migrations = await runMigrations();
  await seedReferenceData();
  let admin = false;
  try {
    admin = await ensureAdmin() !== null;
  } catch (error) {
    console.error('[provision] Admin setup skipped:', error instanceof Error ? error.message : String(error));
  }
  return { migrations: migrations.count, files: migrations.files, admin };
}
