-- Magnum Opus event log schema (Phase 1.5)
-- Run via: npm run migrate
-- Written to be idempotent: safe to run against a fresh or an existing database.

CREATE TABLE IF NOT EXISTS simulation_runs (
  run_id UUID PRIMARY KEY,
  config JSONB NOT NULL,
  seed TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' -- running | completed | failed
);
ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS seed TEXT;

CREATE TABLE IF NOT EXISTS actors (
  actor_id UUID PRIMARY KEY,
  run_id UUID REFERENCES simulation_runs(run_id) ON DELETE CASCADE,
  persona_type TEXT NOT NULL,
  actor_index INTEGER,
  synthetic_user_id TEXT,
  seed TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE actors ADD COLUMN IF NOT EXISTS actor_index INTEGER;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS seed TEXT;

CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY,
  run_id UUID REFERENCES simulation_runs(run_id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(actor_id) ON DELETE CASCADE,

  trace_id UUID NOT NULL,
  -- Deliberately NOT a foreign key. Events are an append-only log written in
  -- batches; enforcing referential order on a buffered writer trades a real
  -- reliability risk for integrity this table does not need.
  parent_event_id UUID,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- stamped in-process at event time
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the batch landed
  trace_sequence INTEGER,                          -- per-trace ordinal
  epoch INTEGER DEFAULT 0,                         -- simulation wave
  sequence_number BIGSERIAL,

  event_type TEXT NOT NULL,   -- http_request | late_response | decision | wait | verification
  action TEXT NOT NULL,
  outcome TEXT,               -- success | timeout | error | abandoned | match | mismatch

  latency_ms INTEGER,
  http_status INTEGER,
  idempotency_key TEXT,
  attempt_number INTEGER,

  payload JSONB,
  tags TEXT[] DEFAULT '{}'
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE events ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE events ADD COLUMN IF NOT EXISTS trace_sequence INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS attempt_number INTEGER;
-- Phase 3: which wave of the simulation this event belongs to.
ALTER TABLE events ADD COLUMN IF NOT EXISTS epoch INTEGER DEFAULT 0;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS epoch INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(run_id, epoch, action);

-- Upgrade path from Phase 1: drop the parent_event_id FK if it exists.
DO $$
DECLARE fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'events'::regclass
    AND contype = 'f'
    AND confrelid = 'events'::regclass;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_run_trace ON events(run_id, trace_id, trace_sequence);
CREATE INDEX IF NOT EXISTS idx_events_run_type ON events(run_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_idempotency ON events(run_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_events_action_outcome ON events(action, outcome);

CREATE TABLE IF NOT EXISTS findings (
  finding_id UUID PRIMARY KEY,
  run_id UUID REFERENCES simulation_runs(run_id) ON DELETE CASCADE,
  severity TEXT NOT NULL,      -- critical | warning | info
  detector TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_trace_ids UUID[] DEFAULT '{}',
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence JSONB;
-- Stable identity for a finding across runs, so two runs can be diffed.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS signature JSONB;
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(run_id, fingerprint);
