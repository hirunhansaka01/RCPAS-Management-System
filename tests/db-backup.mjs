// Snapshot / restore the SQLite DB so a regression run cannot lose live data.
// Usage: node tests/db-backup.mjs snapshot | node tests/db-backup.mjs restore
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LIVE = 'data/rcpas.sqlite';
const SNAP = 'data/rcpas-backup.sqlite';
const mode = process.argv[2];

if (mode === 'snapshot') {
  if (fs.existsSync(SNAP)) fs.rmSync(SNAP);
  const db = new DatabaseSync(LIVE);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  db.close();
  const counts = (file) => {
    const d = new DatabaseSync(file);
    d.exec('PRAGMA busy_timeout=5000');
    const out = {};
    for (const t of ['events', 'members', 'equipment', 'audit_logs', 'users']) out[t] = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    d.close();
    return out;
  };
  console.log('snapshot ->', SNAP, JSON.stringify(counts(SNAP)));
} else if (mode === 'restore') {
  if (!fs.existsSync(SNAP)) { console.error('no snapshot found at', SNAP); process.exit(1); }
  fs.copyFileSync(SNAP, LIVE);
  const d = new DatabaseSync(LIVE);
  d.exec('PRAGMA busy_timeout=5000');
  const out = {};
  for (const t of ['events', 'members', 'equipment', 'audit_logs', 'users']) out[t] = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const ev = d.prepare('SELECT event_code, name, status FROM events').all();
  d.close();
  console.log('restored <-', SNAP, JSON.stringify(out));
  console.log('events:', JSON.stringify(ev));
} else {
  console.error('usage: node tests/db-backup.mjs snapshot|restore');
  process.exit(1);
}
