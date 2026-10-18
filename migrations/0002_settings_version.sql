-- Conditional configuration saves must use a revision, not a millisecond timestamp.
ALTER TABLE settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
