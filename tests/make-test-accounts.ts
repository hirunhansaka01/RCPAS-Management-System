import { execute, query } from '../src/server/db.js';
import { hashPassword } from '../src/server/password.js';

// Creates non-administrator official accounts so the permission matrix can be
// verified end-to-end. Removed again by tests/reset-data.mjs (accounts are kept)
// or by tests/remove-test-accounts.ts.
const accounts: [string, string, string, string][] = [
  ['local:president@rcpas.local', 'president@rcpas.local', 'Test President', 'President'],
  ['local:chief@rcpas.local', 'chief@rcpas.local', 'Test Chief Organizer', 'Chief Organizer'],
  ['local:organizer@rcpas.local', 'organizer@rcpas.local', 'Test Authorized Organizer', 'Authorized Organizer'],
];

// Passwords are never committed. They are read from the environment (see
// .env.example -> TEST_*_PASSWORD) so this file can live in a public repository
// while still creating accounts the smoke suites can sign in as - those suites
// read the very same variables through tests/creds.mjs.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env, fill in the TEST_*_PASSWORD entries, then re-run. See README.md -> "Testing".`);
  }
  return value;
}

const passwords: Record<string, string> = {
  'president@rcpas.local': required('TEST_PRESIDENT_PASSWORD'),
  'chief@rcpas.local': required('TEST_CHIEF_PASSWORD'),
  'organizer@rcpas.local': required('TEST_ORGANIZER_PASSWORD'),
};

for (const [openId, email, displayName, roleName] of accounts) {
  await execute('INSERT INTO users (open_id, email, display_name, active) VALUES (?, ?, ?, 1) ON CONFLICT(open_id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name, active=1', [openId, email, displayName]);
  const user = await query<{ id: number }[]>('SELECT id FROM users WHERE open_id=?', [openId]);
  const role = await query<{ id: number }[]>('SELECT id FROM system_roles WHERE name=?', [roleName]);
  if (!user[0] || !role[0]) throw new Error(`Missing user or role ${roleName}. Run db:migrate and db:seed first.`);
  await execute('DELETE FROM user_roles WHERE user_id=?', [user[0].id]);
  await execute('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [user[0].id, role[0].id]);
  await execute('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP WHERE id=?', [await hashPassword(passwords[email]), user[0].id]);
  console.log(`Test account ready (${roleName}): ${email}`);
}
process.exit(0);
