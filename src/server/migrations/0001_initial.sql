CREATE TABLE IF NOT EXISTS system_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL,
  permission_id INTEGER NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES system_roles(id),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES system_roles(id)
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  grade TEXT NOT NULL,
  class_name TEXT NOT NULL,
  membership_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','On Leave','Alumni','Inactive')),
  phone TEXT NULL,
  email TEXT NULL,
  experience TEXT NULL,
  skills TEXT NULL,
  availability TEXT NULL,
  notes TEXT NULL,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_grade_class ON members(grade, class_name);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(full_name);
CREATE TABLE IF NOT EXISTS creative_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS member_roles (
  member_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'Contributor',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id, role_id),
  CONSTRAINT fk_member_roles_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_member_roles_role FOREIGN KEY (role_id) REFERENCES creative_roles(id)
);
CREATE TABLE IF NOT EXISTS equipment_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_code TEXT NOT NULL UNIQUE,
  asset_id TEXT NULL UNIQUE,
  category_id INTEGER NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  ownership TEXT NOT NULL CHECK (ownership IN ('Society Owned','Personally Owned')),
  responsible_member_id INTEGER NULL,
  condition_status TEXT NOT NULL DEFAULT 'Good' CHECK (condition_status IN ('Excellent','Good','Needs Service','Damaged','Unavailable')),
  availability TEXT NOT NULL DEFAULT 'Available' CHECK (availability IN ('Available','Allocated','Unavailable','Archived')),
  notes TEXT NULL,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_equipment_category FOREIGN KEY (category_id) REFERENCES equipment_categories(id),
  CONSTRAINT fk_equipment_member FOREIGN KEY (responsible_member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_equipment_availability ON equipment(availability);
CREATE INDEX IF NOT EXISTS idx_equipment_ownership ON equipment(ownership);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NULL,
  category TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  venue TEXT NOT NULL,
  organizer_member_id INTEGER NULL,
  photography_requirements TEXT NULL,
  creative_requirements TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Upcoming' CHECK (status IN ('Upcoming','Ongoing','Completed','Cancelled')),
  notes TEXT NULL,
  created_by INTEGER NULL,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_organizer FOREIGN KEY (organizer_member_id) REFERENCES members(id),
  CONSTRAINT fk_events_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_events_status_date ON events(status, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_dates ON events(starts_at, ends_at);
CREATE TABLE IF NOT EXISTS event_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  responsibility TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Proposed' CHECK (status IN ('Proposed','Confirmed','Completed','Cancelled')),
  notes TEXT NULL,
  override_reason TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignments_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_assignments_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_assignments_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT uq_event_member_responsibility UNIQUE (event_id, member_id, responsibility)
);
CREATE INDEX IF NOT EXISTS idx_assignments_member ON event_assignments(member_id, status);
CREATE TABLE IF NOT EXISTS event_equipment_requirements (
  event_id INTEGER NOT NULL,
  equipment_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, equipment_id),
  CONSTRAINT fk_event_equipment_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_event_equipment_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id)
);
CREATE TABLE IF NOT EXISTS equipment_allocations (
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
CREATE INDEX IF NOT EXISTS idx_alloc_equipment_dates ON equipment_allocations(equipment_id, issued_at, returned_at);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NULL,
  details TEXT NULL,
  ip_address TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS society_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by INTEGER NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
);
