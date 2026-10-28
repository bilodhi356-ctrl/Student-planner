CREATE TABLE IF NOT EXISTS programs (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

INSERT INTO programs(code, name)
VALUES ('BSC-CT', 'BSc Computer Technology'), ('BSC-CS', 'BSc Computer Science')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin', 'class_rep')),
  program_id BIGINT REFERENCES programs(id) ON DELETE SET NULL,
  year_of_study INTEGER CHECK (year_of_study BETWEEN 1 AND 8),
  semester INTEGER CHECK (semester BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE students ADD COLUMN IF NOT EXISTS registration_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS students_registration_number_unique_idx
  ON students (UPPER(registration_number)) WHERE registration_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS venues (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  building TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS units (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  program_id BIGINT REFERENCES programs(id) ON DELETE SET NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 8),
  semester INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 3),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS unit_programs (
  unit_id BIGINT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  program_id BIGINT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  PRIMARY KEY (unit_id, program_id)
);

INSERT INTO unit_programs(unit_id, program_id)
SELECT id, program_id FROM units WHERE program_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  venue_id BIGINT REFERENCES venues(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture', 'exam')),
  group_name TEXT NOT NULL DEFAULT 'A',
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  session_date DATE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time <> end_time),
  CHECK ((kind = 'lecture' AND day_of_week IS NOT NULL) OR (kind = 'exam' AND session_date IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sessions_unit_idx ON sessions(unit_id);
CREATE INDEX IF NOT EXISTS sessions_date_idx ON sessions(session_date);

CREATE TABLE IF NOT EXISTS selections (
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  unit_id BIGINT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  selected_group TEXT,
  PRIMARY KEY (student_id, unit_id)
);

CREATE TABLE IF NOT EXISTS timetable_imports (
  id BIGSERIAL PRIMARY KEY,
  uploaded_by BIGINT REFERENCES students(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS timetable_changes (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES timetable_imports(id) ON DELETE CASCADE,
  unit_code TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('added', 'changed', 'removed')),
  before_data JSONB,
  after_data JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminder_preferences (
  student_id BIGINT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  exam_hours_before INTEGER NOT NULL DEFAULT 24,
  class_minutes_before INTEGER NOT NULL DEFAULT 60,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  occurrence_start TIMESTAMPTZ NOT NULL,
  reminder_kind TEXT NOT NULL CHECK (reminder_kind IN ('exam', 'first-class')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_id, session_id, occurrence_start, reminder_kind)
);
