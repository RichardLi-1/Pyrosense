-- PROJECT_NAME · Tiger Data (TimescaleDB) schema
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql
-- Idempotent. Coordinates are metres in the session's SLAM `map` frame.
--
-- If this database still has the v1 scaffold tables (gas_samples, poses,
-- map_snapshots, field_estimates, gas_cells_10s and the old `alerts`),
-- run db/migrate_from_v1.sql first. This file refuses to run over them.

CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'alerts' AND column_name = 'kind') THEN
    RAISE EXCEPTION 'Legacy v1 schema detected (alerts.kind). Run db/migrate_from_v1.sql first.';
  END IF;
END $$;

-- One row per VOC sample, already placed on the map by voc_mapper on the Pi.
CREATE TABLE IF NOT EXISTS readings (
  ts       TIMESTAMPTZ NOT NULL,
  session  TEXT        NOT NULL,
  x        REAL        NOT NULL,
  y        REAL        NOT NULL,
  heading  REAL,
  voc      REAL        NOT NULL
);
SELECT create_hypertable('readings', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS readings_session_ts ON readings (session, ts DESC);

-- The heat map lives here: 10 s buckets × 20 cm cells.
-- materialized_only = false so /heatmap also sees rows newer than the last refresh.
CREATE MATERIALIZED VIEW IF NOT EXISTS voc_cells
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('10 seconds', ts) AS bucket,
       session,
       floor(x / 0.2)::int AS cx,
       floor(y / 0.2)::int AS cy,
       avg(voc)    AS mean,
       stddev(voc) AS sd,
       count(*)    AS n
FROM readings
GROUP BY bucket, session, cx, cy
WITH NO DATA;

-- start_offset NULL = no lower bound, so rows that arrive late (DB outage backlog,
-- replayed walks, a wrong Pi clock) still get materialized. Each run only recomputes
-- buckets that changed, so this stays cheap. Re-created so existing DBs pick it up.
SELECT remove_continuous_aggregate_policy('voc_cells', if_exists => TRUE);
SELECT add_continuous_aggregate_policy('voc_cells',
  start_offset      => NULL,
  end_offset        => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds');

ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'session',
  timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('readings', INTERVAL '1 hour', if_not_exists => TRUE);

-- Exposure alerts from the backend alert engine (live reading > threshold for HOLD seconds).
CREATE TABLE IF NOT EXISTS alerts (
  id       SERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL,
  session  TEXT        NOT NULL,
  x        REAL,
  y        REAL,
  voc      REAL,
  map_png  BYTEA,
  map_origin_x REAL,
  map_origin_y REAL,
  map_res      REAL
);
CREATE INDEX IF NOT EXISTS alerts_session_ts ON alerts (session, ts DESC);

-- Saved scans: a name and the final floor plan for a session, so past walks can be browsed.
CREATE TABLE IF NOT EXISTS sessions_meta (
  session      TEXT PRIMARY KEY,
  name         TEXT,
  notes        TEXT,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  map_png      BYTEA,
  map_origin_x REAL,
  map_origin_y REAL,
  map_res      REAL,
  map_w        INT,
  map_h        INT
);
