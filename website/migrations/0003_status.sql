-- The status page at /status. A scheduled Worker (ops/retention-worker.ts, every
-- minute) reads GET /v1/status from the API and keeps what it saw here, so the
-- page still answers, with history, when the API does not. GET /api/status
-- serves it. Nothing here is personal data.

-- One row a minute, kept 7 days: what the monitor saw.
CREATE TABLE status_checks (
  checked_at INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('operational','degraded','partial_outage','maintenance','major_outage','unreachable')),
  http_status INTEGER,
  latency_ms INTEGER,
  error TEXT
);

-- One row per UTC day, kept 90 days. `down` counts checks in an outage: the API
-- reported major_outage, or it did not answer twice or more in a row. A single
-- unanswered check is `missed`, not down.
CREATE TABLE status_days (
  day TEXT PRIMARY KEY CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  checks INTEGER NOT NULL DEFAULT 0,
  operational INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  maintenance INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  missed INTEGER NOT NULL DEFAULT 0
);

-- The latest check, and the last answer the API gave.
CREATE TABLE status_snapshot (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  checked_at INTEGER NOT NULL,
  answered_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json))
);

-- Outages the monitor saw for itself (two or more unanswered checks in a row), kept 90 days.
CREATE TABLE status_outages (
  started_at INTEGER PRIMARY KEY,
  ended_at INTEGER,
  checks INTEGER NOT NULL DEFAULT 0
);

-- Incident and maintenance notices as the API last showed them, kept 90 days
-- after they end (the API itself lists resolved ones for 14 days).
CREATE TABLE status_notices (
  id TEXT PRIMARY KEY,
  starts_at TEXT NOT NULL,
  resolved_at TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  seen_at INTEGER NOT NULL
);
CREATE INDEX status_notices_starts ON status_notices(starts_at);
