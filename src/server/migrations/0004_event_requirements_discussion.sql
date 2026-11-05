-- Stage 1b: structured gear requirements + official planning discussion.
--
-- event_equipment_requirements existed but was never wired to any endpoint and
-- only carried (event_id, equipment_id, quantity). Event planning needs a
-- requirement to exist even when no member owns the gear yet, so the link to
-- `equipment` becomes optional and a free-text description becomes the identity
-- of the requirement. It has 0 rows, so the rebuild loses nothing.

PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS event_equipment_requirements_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  equipment_id INTEGER REFERENCES equipment(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT 'Required',
  notes TEXT,
  waived_at TEXT,
  waived_by INTEGER REFERENCES users(id),
  waived_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sources only columns present in both the legacy and rebuilt table, so this
-- copy works on a first run (from the legacy table) and on every re-run.
INSERT OR IGNORE INTO event_equipment_requirements_v2
  (event_id, equipment_id, description, quantity, created_by, created_at, updated_at)
SELECT r.event_id, r.equipment_id,
       COALESCE(NULLIF(TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')), ''), 'Equipment requirement'),
       CASE WHEN r.quantity > 0 THEN r.quantity ELSE 1 END,
       NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM event_equipment_requirements r LEFT JOIN equipment e ON e.id = r.equipment_id;

DROP TABLE event_equipment_requirements;
ALTER TABLE event_equipment_requirements_v2 RENAME TO event_equipment_requirements;

CREATE INDEX IF NOT EXISTS idx_equipment_req_event ON event_equipment_requirements(event_id);
-- One requirement of a given description per event: prevents duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_req_event_desc ON event_equipment_requirements(event_id, description);

-- Internal planning discussion among authorized officials. Ordinary members
-- have no login accounts, so this can never become a public forum.
CREATE TABLE IF NOT EXISTS event_discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_discussion_event ON event_discussions(event_id);

PRAGMA foreign_keys=ON;
