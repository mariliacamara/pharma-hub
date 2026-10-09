-- Job runs: tell a run that is being worked on from one that was abandoned.
--
-- A run is executed by a worker inside the service. If the service stops in the middle
-- (a deploy, a crash), the row would say "running" forever and, because only one full
-- collection per store may be active, block every later run of that store.
--
--   heartbeat_at  the worker writes the time here while it works. A running row whose
--                 heartbeat is old was abandoned and can be taken up again.
--   attempts      how many times a worker started this run. A run that keeps being
--                 abandoned is failed instead of retried forever.
--
-- Safe on a live table: adding a nullable column, or a column with a constant default,
-- does not rewrite the table (PostgreSQL 11 and later) and holds its lock only for an
-- instant.

ALTER TABLE job_runs
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0);

-- A heartbeat only exists once a worker has started the run.
ALTER TABLE job_runs
  ADD CONSTRAINT job_runs_heartbeat_after_start_check
  CHECK (heartbeat_at IS NULL OR started_at IS NULL OR heartbeat_at >= started_at);
