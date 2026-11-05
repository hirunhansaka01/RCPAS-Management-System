// Clears transactional data so the Stage 1 smoke test starts from a known state.
// Reference data (roles, permissions, creative roles, categories) and official
// accounts are preserved. Run with: node tests/reset-data.mjs
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/rcpas.sqlite');
db.exec('PRAGMA foreign_keys=OFF');

const tables = [
  'audit_logs', 'auth_sessions', 'event_assignments', 'event_equipment_commitments',
  'event_equipment_requirements', 'equipment_allocations', 'equipment',
  'member_roles', 'members', 'events', 'society_settings',
];

for (const t of tables) db.exec(`DELETE FROM ${t}`);
db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t}'`).join(',')})`);

const counts = {};
for (const t of tables) counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
const users = db.prepare('SELECT email FROM users ORDER BY id').all();
const roles = db.prepare('SELECT name FROM system_roles ORDER BY id').all();

console.log('Row counts after reset:');
for (const [t, c] of Object.entries(counts)) console.log(`  ${t.padEnd(32)} ${c}`);
console.log('Official accounts:', users.map((u) => u.email).join(', '));
console.log('System roles:', roles.map((r) => r.name).join(', '));
db.close();
