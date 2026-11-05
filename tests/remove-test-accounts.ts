import { execute, query } from '../src/server/db.js';

// Removes the accounts created by tests/make-test-accounts.ts, including any
// records those accounts authored, so no foreign keys are left dangling.
const emails = ['president@rcpas.local', 'chief@rcpas.local', 'organizer@rcpas.local'];

for (const email of emails) {
  const users = await query<{ id: number }[]>('SELECT id FROM users WHERE email=?', [email]);
  const userId = users[0]?.id;
  if (!userId) {
    console.log(`No test account ${email}`);
    continue;
  }

  // Records authored by this account reference users with on_delete=NO ACTION.
  for (const [table, column] of [
    ['event_assignments', 'created_by'],
    ['event_equipment_commitments', 'created_by'],
    ['equipment_allocations', 'created_by'],
    ['events', 'created_by'],
    ['society_settings', 'updated_by'],
  ] as const) {
    await execute(`DELETE FROM ${table} WHERE ${column}=?`, [userId]);
  }

  await execute('DELETE FROM audit_logs WHERE user_id=?', [userId]);
  await execute('DELETE FROM auth_sessions WHERE user_id=?', [userId]);
  await execute('DELETE FROM user_roles WHERE user_id=?', [userId]);
  await execute('DELETE FROM users WHERE id=?', [userId]);
  console.log(`Removed test account ${email} (id ${userId}) and its authored records`);
}
process.exit(0);
