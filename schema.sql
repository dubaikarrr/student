CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total_rows INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  centre TEXT NOT NULL,
  exam_date TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_availability_run_id ON availability(run_id);
CREATE INDEX IF NOT EXISTS idx_availability_state_city ON availability(state, city);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status_started ON scan_runs(status, started_at DESC);
