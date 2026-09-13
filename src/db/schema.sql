-- ACA Appointments — schema
-- All date/time values are stored as school-local strings:
--   dates  'YYYY-MM-DD'
--   times  'HH:MM'  (24h)
--   stamps 'YYYY-MM-DD HH:MM:SS' (UTC, for audit columns only)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campuses (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  name_ar     TEXT,
  slug        TEXT NOT NULL UNIQUE,
  address     TEXT,
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY,
  campus_id   INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_ar     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_departments_campus ON departments(campus_id);

-- Staff = teachers, department heads, front-desk / uniform-shop operators, admins.
CREATE TABLE IF NOT EXISTS staff (
  id             INTEGER PRIMARY KEY,
  campus_id      INTEGER REFERENCES campuses(id) ON DELETE SET NULL,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  name_ar        TEXT,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  title          TEXT,
  role           TEXT NOT NULL DEFAULT 'teacher',  -- admin | campus_admin | teacher | desk
  password_hash  TEXT,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_campus ON staff(campus_id);
CREATE INDEX IF NOT EXISTS idx_staff_dept ON staff(department_id);

-- A class / section taught by a member of staff. Parents pick the class,
-- which is what a teacher's slot sheet hangs off for conference events.
CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,           -- e.g. "Grade 6B — Mathematics"
  grade_level TEXT,                    -- e.g. "6"
  room        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_classes_staff ON classes(staff_id);

-- An event is one bookable window: "PTC Term 1 — Hawally", "Uniform fitting — Salmiya".
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY,
  campus_id         INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  type              TEXT NOT NULL DEFAULT 'conference', -- conference | uniform | registration | other
  name              TEXT NOT NULL,
  name_ar           TEXT,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT,
  instructions      TEXT,               -- shown to parents before they book
  instructions_ar   TEXT,
  opens_at          TEXT,               -- 'YYYY-MM-DD HH:MM' local; null = open now
  closes_at         TEXT,               -- booking closes
  max_per_student   INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited
  prevent_overlap   INTEGER NOT NULL DEFAULT 1,  -- block two slots at the same clock time for one student
  allow_cancel      INTEGER NOT NULL DEFAULT 1,
  cancel_cutoff_hrs INTEGER NOT NULL DEFAULT 2,  -- no self-cancel inside this window
  require_phone     INTEGER NOT NULL DEFAULT 1,
  collect_student   INTEGER NOT NULL DEFAULT 1,  -- ask for student name/grade (off for e.g. campus tours)
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | published | closed | archived
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_campus ON events(campus_id);

-- A schedule is one bookable calendar inside an event.
-- Conference events: one schedule per class (owned by its teacher).
-- Uniform / registration events: one schedule per service desk (owned by a 'desk' staff row,
-- or with no owner at all — just a label like "Uniform counter 2").
CREATE TABLE IF NOT EXISTS schedules (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  staff_id       INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  class_id       INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  label          TEXT,                       -- overrides the class/staff name when set
  mode           TEXT NOT NULL DEFAULT 'in_person', -- in_person | phone | video
  location       TEXT,
  meeting_link   TEXT,
  notes          TEXT,
  locked         INTEGER NOT NULL DEFAULT 0, -- teacher froze the sheet: no new parent bookings
  published      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_event ON schedules(event_id);
CREATE INDEX IF NOT EXISTS idx_schedules_staff ON schedules(staff_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_event_class ON schedules(event_id, class_id)
  WHERE class_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS slots (
  id           INTEGER PRIMARY KEY,
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  slot_date    TEXT NOT NULL,   -- 'YYYY-MM-DD'
  start_time   TEXT NOT NULL,   -- 'HH:MM'
  end_time     TEXT NOT NULL,   -- 'HH:MM'
  capacity     INTEGER NOT NULL DEFAULT 1,
  blocked      INTEGER NOT NULL DEFAULT 0, -- break / held by staff, not bookable
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, slot_date, start_time)
);
CREATE INDEX IF NOT EXISTS idx_slots_schedule ON slots(schedule_id, slot_date, start_time);

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY,
  slot_id        INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  schedule_id    INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  student_name   TEXT,
  student_grade  TEXT,
  student_ref    TEXT,            -- optional student ID typed by the parent
  parent_name    TEXT NOT NULL,
  parent_email   TEXT NOT NULL,
  parent_phone   TEXT,
  notes          TEXT,            -- "what would you like to discuss"
  status         TEXT NOT NULL DEFAULT 'booked', -- booked | cancelled | attended | no_show
  token          TEXT NOT NULL UNIQUE,           -- self-service manage link
  group_token    TEXT,            -- ties together one parent's multi-teacher submission
  language       TEXT NOT NULL DEFAULT 'en',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at   TEXT,
  cancelled_by   TEXT             -- parent | staff | admin
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(parent_email);
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings(group_token);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,   -- email | whatsapp
  kind        TEXT NOT NULL,   -- confirmation | cancellation | reminder
  recipient   TEXT,
  status      TEXT NOT NULL,   -- sent | skipped | failed
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notifications(booking_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
