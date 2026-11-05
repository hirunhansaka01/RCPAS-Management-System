// Lists every foreign key in the database so cleanup order can be correct.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/rcpas.sqlite');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();

for (const { name } of tables) {
  const fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all();
  for (const fk of fks) {
    if (fk.table === 'users') console.log(`${name}.${fk.from} -> users.${fk.to}  (on_delete=${fk.on_delete})`);
  }
}
db.close();
