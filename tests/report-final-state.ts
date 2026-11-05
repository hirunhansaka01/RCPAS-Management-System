import { query } from '../src/server/db.js';

const rolePerms = await query<{ name: string; perms: number }[]>(
  `SELECT r.name, COUNT(*) as perms FROM system_roles r
   JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
   GROUP BY r.name ORDER BY perms DESC`
);
console.log('--- Permission matrix (role -> granted permissions) ---');
for (const row of rolePerms) console.log(`  ${row.name.padEnd(24)} ${row.perms}`);

const totalPerms = await query<{ c: number }[]>('SELECT COUNT(*) c FROM permissions');
const adminPerms = await query<{ perms: number }[]>(
  `SELECT COUNT(*) as perms FROM role_permissions rp
   JOIN system_roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
   WHERE r.name='System Administrator'`
);
console.log(`\n  Total permissions defined: ${totalPerms[0].c}`);
console.log(`  System Administrator holds: ${adminPerms[0].perms} (must equal total)`);

const registerHolders = await query<{ name: string }[]>(
  `SELECT r.name FROM role_permissions rp
   JOIN system_roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
   WHERE p.code='members.register' ORDER BY r.name`
);
console.log(`  members.register granted to: ${registerHolders.map((r) => r.name).join(', ')}`);

const cr = await query<{ c: number }[]>('SELECT COUNT(*) c FROM creative_roles');
const ec = await query<{ c: number }[]>('SELECT COUNT(*) c FROM equipment_categories');
const cats = await query<{ name: string }[]>('SELECT name FROM equipment_categories ORDER BY id');
const crs = await query<{ name: string }[]>('SELECT name FROM creative_roles ORDER BY id');
console.log(`\n  creative_roles (${cr[0].c}): ${crs.map((r) => r.name).join(', ')}`);
console.log(`  equipment_categories (${ec[0].c}): ${cats.map((c) => c.name).join(', ')}`);

const accounts = await query<{ email: string; display_name: string }[]>('SELECT email, display_name FROM users ORDER BY id');
console.log(`\n  Accounts: ${accounts.map((a) => a.email).join(', ')}`);

const empties = ['members', 'events', 'equipment', 'event_assignments', 'event_equipment_commitments', 'audit_logs'];
console.log('\n--- Transactional tables (should all be 0 after reset) ---');
for (const t of empties) {
  const r = await query<{ c: number }[]>(`SELECT COUNT(*) c FROM ${t}`);
  console.log(`  ${t.padEnd(32)} ${r[0].c}`);
}
process.exit(0);
