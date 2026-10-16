CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'once', 'manual')),
  cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  run_at INTEGER,
  executor_type TEXT NOT NULL,
  executor_config TEXT NOT NULL,
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip', 'parallel')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_interval_seconds INTEGER NOT NULL DEFAULT 10,
  alert_config TEXT NOT NULL DEFAULT '{"mode":"inherit"}',
  -- 'inherit' follows the EXECUTION_MODE variable.
  execution_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (execution_mode IN ('inherit', 'queue', 'direct', 'worker')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- D1 bills each index a write touches as an extra row written, so runs is
-- WITHOUT ROWID (the TEXT primary key is the table, not a separate unique index)
-- and keeps only two indexes: per-task listing / retention purge, and a partial
-- index of in-flight runs for the lost-run sweep (finished runs leave it).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'retrying', 'success', 'failed', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  response_body TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_runs_task_created ON runs (task_id, created_at DESC);
CREATE INDEX idx_runs_inflight ON runs (updated_at) WHERE status IN ('running', 'retrying');

CREATE TABLE variables (
  name TEXT PRIMARY KEY,
  value_encrypted TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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
