PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- events: add the new planning columns to the existing table first so that the
--         rebuild below can read them (and so a re-run hits the duplicate-column
--         skip in migrate.ts instead of failing or wiping data).
-- ---------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN event_date TEXT NULL;
ALTER TABLE events ADD COLUMN start_time TEXT NULL;
ALTER TABLE events ADD COLUMN priority TEXT NULL;
ALTER TABLE events ADD COLUMN required_team_size TEXT NULL;
ALTER TABLE events ADD COLUMN additional_instructions TEXT NULL;
ALTER TABLE events ADD COLUMN is_draft TEXT NULL;
UPDATE events SET
  event_date = COALESCE(event_date, COALESCE(date(starts_at), '1970-01-01')),
  start_time = COALESCE(start_time, COALESCE(strftime('%H:%M', starts_at), '00:00')),
  priority = COALESCE(priority, 'Normal'),
  required_team_size = COALESCE(required_team_size, '0'),
  is_draft = COALESCE(is_draft, CASE WHEN status = 'Upcoming' THEN '1' ELSE '0' END);

-- Rebuild to enforce NOT NULL / CHECK constraints and the new status set.
CREATE TABLE IF NOT EXISTS events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NULL,
  category TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NULL,
  venue TEXT NOT NULL,
  organizer_member_id INTEGER NULL,
  priority TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Critical')),
  required_team_size INTEGER NOT NULL DEFAULT 0,
  additional_instructions TEXT NULL,
  photography_requirements TEXT NULL,
  creative_requirements TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Planning' CHECK (status IN ('Planning','Ready','Confirmed','Completed','Cancelled')),
  is_draft INTEGER NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_by INTEGER NULL,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_organizer FOREIGN KEY (organizer_member_id) REFERENCES members(id),
  CONSTRAINT fk_events_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
INSERT INTO events_v2 (id, event_code, name, description, category, event_date, start_time, starts_at, ends_at,
  venue, organizer_member_id, priority, required_team_size, additional_instructions,
  photography_requirements, creative_requirements, status, is_draft, notes, created_by, archived_at, created_at, updated_at)
SELECT id, event_code, name, description, category,
  COALESCE(event_date, COALESCE(date(starts_at), '1970-01-01')),
  COALESCE(start_time, COALESCE(strftime('%H:%M', starts_at), '00:00')),
  starts_at, ends_at, venue, organizer_member_id,
  COALESCE(priority, 'Normal'),
  CAST(COALESCE(required_team_size, '0') AS INTEGER),
  additional_instructions, photography_requirements, creative_requirements,
  CASE status WHEN 'Upcoming' THEN 'Planning' WHEN 'Ongoing' THEN 'Confirmed' ELSE status END,
  CAST(COALESCE(is_draft, '0') AS INTEGER),
  notes, created_by, archived_at, created_at, updated_at
FROM events WHERE id NOT IN (SELECT id FROM events_v2);
-- `DROP TABLE events` is refused while child rows reference events(id), and
-- Turso's HTTP driver never applies the `PRAGMA foreign_keys=OFF` on line 1 -
-- each statement runs on its own session, so the pragma cannot reach the
-- statement that needs it. Renaming changes no rows: SQLite only repoints the
-- children's REFERENCES clauses, so every record survives and the rebuilt
-- schema still lands. The children are re-pointed back to `events` further
-- down, after which `events_old` is dropped.
ALTER TABLE events RENAME TO events_old;
ALTER TABLE events_v2 RENAME TO events;
CREATE INDEX IF NOT EXISTS idx_events_status_date ON events(status, event_date);
CREATE INDEX IF NOT EXISTS idx_events_dates ON events(event_date, start_time);
CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(event_date);

-- ---------------------------------------------------------------------------
-- event_assignments: contact / confirmation workflow.
-- ---------------------------------------------------------------------------
ALTER TABLE event_assignments ADD COLUMN contacted_at TEXT NULL;
ALTER TABLE event_assignments ADD COLUMN contacted_by TEXT NULL;
ALTER TABLE event_assignments ADD COLUMN confirmed_at TEXT NULL;

CREATE TABLE IF NOT EXISTS event_assignments_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  responsibility TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Proposed' CHECK (status IN ('Proposed','Contact Pending','Contacted','Confirmed','Declined','Reassignment Needed','Completed','Cancelled')),
  notes TEXT NULL,
  override_reason TEXT NULL,
  contacted_at TEXT NULL,
  contacted_by INTEGER NULL,
  confirmed_at TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignments_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_assignments_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_assignments_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT uq_event_member_responsibility UNIQUE (event_id, member_id, responsibility)
);
INSERT INTO event_assignments_v2 (id, event_id, member_id, responsibility, status, notes, override_reason,
  contacted_at, contacted_by, confirmed_at, created_by, created_at, updated_at)
SELECT id, event_id, member_id, responsibility, status, notes, override_reason,
  contacted_at, CAST(contacted_by AS INTEGER), confirmed_at, created_by, created_at, updated_at
FROM event_assignments WHERE id NOT IN (SELECT id FROM event_assignments_v2);
DROP TABLE event_assignments;
ALTER TABLE event_assignments_v2 RENAME TO event_assignments;
CREATE INDEX IF NOT EXISTS idx_assignments_member ON event_assignments(member_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_event ON event_assignments(event_id, status);

-- ---------------------------------------------------------------------------
-- event_assignments (above) now points at the rebuilt `events`. The two other
-- tables that hold rows referencing events(id) must be repointed the same way
-- before `events_old` can be dropped. Each is rebuilt in place with its rows
-- carried over by INSERT..SELECT, so no record is lost. Their `_v2` scratch
-- tables are always empty here (either absent, or already renamed away on a
-- previous run), so a plain INSERT cannot collide.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_equipment_requirements_v2 (
  event_id INTEGER NOT NULL,
  equipment_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, equipment_id),
  CONSTRAINT fk_event_equipment_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_event_equipment_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id)
);
INSERT INTO event_equipment_requirements_v2 (event_id, equipment_id, quantity)
  SELECT event_id, equipment_id, quantity FROM event_equipment_requirements;
DROP TABLE event_equipment_requirements;
ALTER TABLE event_equipment_requirements_v2 RENAME TO event_equipment_requirements;

CREATE TABLE IF NOT EXISTS equipment_allocations_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  issued_at TEXT NULL,
  returned_at TEXT NULL,
  return_status TEXT NOT NULL DEFAULT 'Pending' CHECK (return_status IN ('Pending','Returned','Late','Damaged')),
  notes TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_alloc_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id),
  CONSTRAINT fk_alloc_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_alloc_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT uq_event_equipment UNIQUE (event_id, equipment_id)
);
INSERT INTO equipment_allocations_v2 (id, equipment_id, event_id, quantity, issued_at, returned_at, return_status, notes, created_by, created_at)
  SELECT id, equipment_id, event_id, quantity, issued_at, returned_at, return_status, notes, created_by, created_at FROM equipment_allocations;
DROP TABLE equipment_allocations;
ALTER TABLE equipment_allocations_v2 RENAME TO equipment_allocations;

-- Nothing references events_old any more.
DROP TABLE IF EXISTS events_old;

-- ---------------------------------------------------------------------------
-- equipment: member-owned gear search fields. No manual equipment ID entry.
-- ---------------------------------------------------------------------------
ALTER TABLE equipment ADD COLUMN item_name TEXT NULL;
ALTER TABLE equipment ADD COLUMN focal_length TEXT NULL;
ALTER TABLE equipment ADD COLUMN lens_mount TEXT NULL;
ALTER TABLE equipment ADD COLUMN keywords TEXT NULL;

-- ---------------------------------------------------------------------------
-- Lightweight per-event equipment commitments (owner confirmation per event).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_equipment_commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  equipment_id INTEGER NOT NULL,
  member_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'Awaiting Confirmation' CHECK (status IN ('Offered','Awaiting Confirmation','Confirmed','Declined','Unavailable','Released')),
  notes TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_event_equipment_commitment UNIQUE (event_id, equipment_id),
  CONSTRAINT fk_commitment_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_commitment_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id),
  CONSTRAINT fk_commitment_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_commitment_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_commitments_event ON event_equipment_commitments(event_id, status);

PRAGMA foreign_keys=ON;
