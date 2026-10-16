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
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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
);

CREATE INDEX idx_runs_task_created ON runs (task_id, created_at DESC);
CREATE INDEX idx_runs_created ON runs (created_at);
CREATE INDEX idx_runs_status_updated ON runs (status, updated_at);

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
