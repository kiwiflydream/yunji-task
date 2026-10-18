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
  -- 'inherit' follows the global runtime setting.
  execution_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (execution_mode IN ('inherit', 'queue', 'direct', 'worker')),
  version INTEGER NOT NULL DEFAULT 1,
  scheduler_synced_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_unsynced ON tasks (id) WHERE scheduler_synced_version < version;

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
  execution_mode TEXT CHECK (execution_mode IN ('queue', 'direct', 'worker')),
  effective_timeout_ms INTEGER,
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

CREATE INDEX idx_runs_task_created ON runs (task_id, created_at DESC, id DESC);
CREATE INDEX idx_runs_inflight ON runs (updated_at) WHERE status IN ('running', 'retrying');

-- Durable handoffs created atomically with their run result.
CREATE TABLE run_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  failed_at INTEGER,
  -- An exhausted claim can terminate only after its lease ends.
  terminal_at INTEGER GENERATED ALWAYS AS (
    MAX(lease_until, CASE WHEN attempts >= CASE WHEN json_extract(payload, '$.kind') = 'alert' THEN 3 ELSE 10 END
      THEN 0 ELSE expires_at END)
  ) VIRTUAL
) WITHOUT ROWID;
CREATE INDEX idx_run_actions_due ON run_actions (due_at) WHERE failed_at IS NULL;
CREATE INDEX idx_run_actions_terminal ON run_actions (terminal_at) WHERE failed_at IS NULL;
CREATE INDEX idx_run_actions_run ON run_actions (run_id);

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
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- Minute pre-aggregated run statistics, one row per (task, UTC minute of scheduled_at).
-- Only final outcomes are counted (success / failed / skipped), once per run.
-- dur_b0..dur_b10 is a duration histogram; bucket upper bounds (ms) are
-- 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, +inf (see src/domain/stats.ts).
-- delay_* is the scheduling delay (started_at - scheduled_at) of scheduled runs only.
CREATE TABLE run_stats (
  task_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
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
  PRIMARY KEY (task_id, bucket)
) WITHOUT ROWID;

CREATE INDEX idx_run_stats_bucket ON run_stats (bucket);

CREATE TABLE execution_budget (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(day, kind, task_id)
) WITHOUT ROWID;

-- Kept atomically with task counters; admission never scans all tasks.
CREATE TABLE execution_budget_totals (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(day, kind)
) WITHOUT ROWID;

CREATE TABLE resource_budgets (
  name TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE stats_cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  owner TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_stats_cache_expiry ON stats_cache(expires_at);

-- Transactional hour rollups bound long-range dashboard reads.
CREATE TABLE run_stats_hourly (
  task_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
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
  PRIMARY KEY (task_id, bucket)
) WITHOUT ROWID;

CREATE INDEX idx_run_stats_hourly_bucket ON run_stats_hourly(bucket);
CREATE TRIGGER stats_hourly_insert AFTER INSERT ON run_stats BEGIN
  INSERT INTO run_stats_hourly(task_id,bucket,success,failed,skipped,duration_count,duration_sum,dur_b0,dur_b1,dur_b2,dur_b3,dur_b4,dur_b5,dur_b6,dur_b7,dur_b8,dur_b9,dur_b10,delay_count,delay_sum,duration_max,delay_max)
  VALUES(NEW.task_id,NEW.bucket-NEW.bucket%3600000,NEW.success,NEW.failed,NEW.skipped,NEW.duration_count,NEW.duration_sum,NEW.dur_b0,NEW.dur_b1,NEW.dur_b2,NEW.dur_b3,NEW.dur_b4,NEW.dur_b5,NEW.dur_b6,NEW.dur_b7,NEW.dur_b8,NEW.dur_b9,NEW.dur_b10,NEW.delay_count,NEW.delay_sum,NEW.duration_max,NEW.delay_max)
  ON CONFLICT(task_id,bucket) DO UPDATE SET success=success+excluded.success,failed=failed+excluded.failed,skipped=skipped+excluded.skipped,duration_count=duration_count+excluded.duration_count,duration_sum=duration_sum+excluded.duration_sum,dur_b0=dur_b0+excluded.dur_b0,dur_b1=dur_b1+excluded.dur_b1,dur_b2=dur_b2+excluded.dur_b2,dur_b3=dur_b3+excluded.dur_b3,dur_b4=dur_b4+excluded.dur_b4,dur_b5=dur_b5+excluded.dur_b5,dur_b6=dur_b6+excluded.dur_b6,dur_b7=dur_b7+excluded.dur_b7,dur_b8=dur_b8+excluded.dur_b8,dur_b9=dur_b9+excluded.dur_b9,dur_b10=dur_b10+excluded.dur_b10,delay_count=delay_count+excluded.delay_count,delay_sum=delay_sum+excluded.delay_sum,duration_max=MAX(duration_max,excluded.duration_max),delay_max=MAX(delay_max,excluded.delay_max);
END;
CREATE TRIGGER stats_hourly_update AFTER UPDATE ON run_stats BEGIN
  INSERT INTO run_stats_hourly(task_id,bucket,success,failed,skipped,duration_count,duration_sum,dur_b0,dur_b1,dur_b2,dur_b3,dur_b4,dur_b5,dur_b6,dur_b7,dur_b8,dur_b9,dur_b10,delay_count,delay_sum,duration_max,delay_max)
  VALUES(NEW.task_id,NEW.bucket-NEW.bucket%3600000,NEW.success-OLD.success,NEW.failed-OLD.failed,NEW.skipped-OLD.skipped,NEW.duration_count-OLD.duration_count,NEW.duration_sum-OLD.duration_sum,NEW.dur_b0-OLD.dur_b0,NEW.dur_b1-OLD.dur_b1,NEW.dur_b2-OLD.dur_b2,NEW.dur_b3-OLD.dur_b3,NEW.dur_b4-OLD.dur_b4,NEW.dur_b5-OLD.dur_b5,NEW.dur_b6-OLD.dur_b6,NEW.dur_b7-OLD.dur_b7,NEW.dur_b8-OLD.dur_b8,NEW.dur_b9-OLD.dur_b9,NEW.dur_b10-OLD.dur_b10,NEW.delay_count-OLD.delay_count,NEW.delay_sum-OLD.delay_sum,NEW.duration_max,NEW.delay_max)
  ON CONFLICT(task_id,bucket) DO UPDATE SET success=success+excluded.success,failed=failed+excluded.failed,skipped=skipped+excluded.skipped,duration_count=duration_count+excluded.duration_count,duration_sum=duration_sum+excluded.duration_sum,dur_b0=dur_b0+excluded.dur_b0,dur_b1=dur_b1+excluded.dur_b1,dur_b2=dur_b2+excluded.dur_b2,dur_b3=dur_b3+excluded.dur_b3,dur_b4=dur_b4+excluded.dur_b4,dur_b5=dur_b5+excluded.dur_b5,dur_b6=dur_b6+excluded.dur_b6,dur_b7=dur_b7+excluded.dur_b7,dur_b8=dur_b8+excluded.dur_b8,dur_b9=dur_b9+excluded.dur_b9,dur_b10=dur_b10+excluded.dur_b10,delay_count=delay_count+excluded.delay_count,delay_sum=delay_sum+excluded.delay_sum,duration_max=MAX(duration_max,excluded.duration_max),delay_max=MAX(delay_max,excluded.delay_max);
END;
CREATE TRIGGER stats_hourly_delete AFTER DELETE ON run_stats BEGIN
  UPDATE run_stats_hourly SET success=success-OLD.success,failed=failed-OLD.failed,skipped=skipped-OLD.skipped,duration_count=duration_count-OLD.duration_count,duration_sum=duration_sum-OLD.duration_sum,dur_b0=dur_b0-OLD.dur_b0,dur_b1=dur_b1-OLD.dur_b1,dur_b2=dur_b2-OLD.dur_b2,dur_b3=dur_b3-OLD.dur_b3,dur_b4=dur_b4-OLD.dur_b4,dur_b5=dur_b5-OLD.dur_b5,dur_b6=dur_b6-OLD.dur_b6,dur_b7=dur_b7-OLD.dur_b7,dur_b8=dur_b8-OLD.dur_b8,dur_b9=dur_b9-OLD.dur_b9,dur_b10=dur_b10-OLD.dur_b10,delay_count=delay_count-OLD.delay_count,delay_sum=delay_sum-OLD.delay_sum,duration_max=COALESCE((SELECT MAX(duration_max) FROM run_stats WHERE task_id=OLD.task_id AND bucket>=OLD.bucket-OLD.bucket%3600000 AND bucket<OLD.bucket-OLD.bucket%3600000+3600000),0),delay_max=COALESCE((SELECT MAX(delay_max) FROM run_stats WHERE task_id=OLD.task_id AND bucket>=OLD.bucket-OLD.bucket%3600000 AND bucket<OLD.bucket-OLD.bucket%3600000+3600000),0)
  WHERE task_id=OLD.task_id AND bucket=OLD.bucket-OLD.bucket%3600000;
  DELETE FROM run_stats_hourly WHERE task_id=OLD.task_id AND bucket=OLD.bucket-OLD.bucket%3600000 AND success+failed+skipped=0;
END;
