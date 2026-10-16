-- Per-task execution mode; 'inherit' follows the EXECUTION_MODE variable.
ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (execution_mode IN ('inherit', 'queue', 'direct'));
