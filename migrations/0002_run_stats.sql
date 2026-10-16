-- Hourly pre-aggregated run statistics, one row per (task, UTC hour of scheduled_at).
-- Only final outcomes are counted (success / failed / skipped), once per run.
-- dur_b0..dur_b10 is a duration histogram; bucket upper bounds (ms) are
-- 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, +inf (see src/domain/stats.ts).
-- delay_* is the scheduling delay (started_at - scheduled_at) of scheduled runs only.
CREATE TABLE run_stats_hourly (
  task_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duration_count INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,
  duration_max INTEGER NOT NULL DEFAULT 0,
  dur_b0 INTEGER NOT NULL DEFAULT 0,
  dur_b1 INTEGER NOT NULL DEFAULT 0,
  dur_b2 INTEGER NOT NULL DEFAULT 0,
  dur_b3 INTEGER NOT NULL DEFAULT 0,
  dur_b4 INTEGER NOT NULL DEFAULT 0,
  dur_b5 INTEGER NOT NULL DEFAULT 0,
  dur_b6 INTEGER NOT NULL DEFAULT 0,
  dur_b7 INTEGER NOT NULL DEFAULT 0,
  dur_b8 INTEGER NOT NULL DEFAULT 0,
  dur_b9 INTEGER NOT NULL DEFAULT 0,
  dur_b10 INTEGER NOT NULL DEFAULT 0,
  delay_count INTEGER NOT NULL DEFAULT 0,
  delay_sum INTEGER NOT NULL DEFAULT 0,
  delay_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, hour)
) WITHOUT ROWID;

CREATE INDEX idx_run_stats_hour ON run_stats_hourly (hour);
