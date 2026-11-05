// Recover data/rcpas.sqlite from the VACUUM INTO snapshot.
// A hard-killed server leaves rcpas.sqlite-wal / -shm behind; replacing the main
// DB while they remain makes SQLite see a WAL written for a different database
// ("database disk image is malformed"). They must be removed together.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LIVE = 'data/rcpas.sqlite';
const SNAP = 'data/rcpas-backup.sqlite';
const SIDECARS = ['data/rcpas.sqlite-wal', 'data/rcpas.sqlite-shm', 'data/rcpas.sqlite-journal'];

function counts(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA busy_timeout=5000');
  const out = {};
  for (const t of ['events', 'members', 'equipment', 'audit_logs', 'users', 'role_permissions']) out[t] = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const events = d.prepare('SELECT event_code, name, event_date, status FROM events ORDER BY id').all();
  const users = d.prepare('SELECT email, active FROM users ORDER BY id').all();
  d.close();
  return { out, events, users };
}

console.log('--- snapshot validation ---');
const snap = counts(SNAP);
console.log(JSON.stringify(snap.out));
console.log('events:', JSON.stringify(snap.events));
console.log('users :', JSON.stringify(snap.users));
if (snap.out.events < 1) { console.error('SNAPSHOT LOOKS EMPTY — aborting'); process.exit(2); }
if (!snap.events.some((e) => e.name === 'Sportmeey')) { console.error('Sportmeey missing from snapshot — aborting'); process.exit(2); }

console.log('\n--- removing stale WAL/SHM sidecars ---');
for (const f of SIDECARS) if (fs.existsSync(f)) { fs.rmSync(f); console.log('  removed', f); }

console.log('\n--- restoring snapshot over the live file ---');
fs.copyFileSync(SNAP, LIVE);

const after = counts(LIVE);
console.log(JSON.stringify(after.out));
console.log('events:', JSON.stringify(after.events));
console.log('users :', JSON.stringify(after.users));

if (after.out.events !== snap.out.events || after.out.users !== snap.out.users) {
  console.error('RESTORE MISMATCH'); process.exit(3);
}
if (!after.events.some((e) => e.name === 'Sportmeey')) { console.error('Sportmeey missing after restore'); process.exit(3); }

// Drop any sidecar the verification connection may have recreated.
for (const f of SIDECARS) if (fs.existsSync(f)) fs.rmSync(f);

console.log('\nRECOVERY OK — database matches the snapshot.');
