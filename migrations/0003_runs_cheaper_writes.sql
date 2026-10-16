-- Fewer D1 rows written per run (each index touched by a write is billed as
-- an extra row written):
-- * WITHOUT ROWID: the TEXT primary key becomes the table itself instead of a
--   separate unique index next to a rowid table.
-- * idx_runs_created is gone; retention purges per task via idx_runs_task_created.
-- * the status index only holds in-flight runs (all the lost-run sweep needs),
--   so finished runs leave it and are never written to it again.
-- Measured on a success run (claim + final update + purge): 8 -> 5 rows written.
CREATE TABLE runs_new (
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

INSERT INTO runs_new (id, task_id, trigger, status, attempt, scheduled_at, started_at, finished_at, duration_ms,
  http_status, response_body, error, created_at, updated_at)
SELECT id, task_id, trigger, status, attempt, scheduled_at, started_at, finished_at, duration_ms,
  http_status, response_body, error, created_at, updated_at
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX idx_runs_task_created ON runs (task_id, created_at DESC);
CREATE INDEX idx_runs_inflight ON runs (updated_at) WHERE status IN ('running', 'retrying');
