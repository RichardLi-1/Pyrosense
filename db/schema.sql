-- Firefighter Hazard-Mapping: Tiger Cloud (PostgreSQL + TimescaleDB) schema.
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql
-- Coordinates are metres in the SLAM `map` frame of that session. They are not lat/lon.

CREATE EXTENSION IF NOT EXISTS timescaledb;  -- already on for Tiger Cloud services

-- One walk through one building = one session.
CREATE TABLE IF NOT EXISTS sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ended_at    timestamptz,
    voc_unit    text NOT NULL DEFAULT 'voc_index',  -- 'voc_index' (SGP40) | 'ppb' (SGP30) | 'ohm' (BME68x)
    voc_threshold real NOT NULL,                    -- danger threshold, in voc_unit
    source      text NOT NULL DEFAULT 'live',       -- 'live' | 'bag'
    notes       text
);

-- Raw fused readings: one row per /gas_points message.
CREATE TABLE IF NOT EXISTS gas_samples (
    time        timestamptz NOT NULL,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    wearer_id   text NOT NULL DEFAULT 'w1',
    x           double precision NOT NULL,
    y           double precision NOT NULL,
    voc         real NOT NULL
);
SELECT create_hypertable('gas_samples', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS gas_samples_session_time ON gas_samples (session_id, time DESC);

-- Wearer path, downsampled to about 5 Hz by the backend.
CREATE TABLE IF NOT EXISTS poses (
    time        timestamptz NOT NULL,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    wearer_id   text NOT NULL DEFAULT 'w1',
    x           double precision NOT NULL,
    y           double precision NOT NULL,
    theta       real NOT NULL                 -- yaw, radians
);
SELECT create_hypertable('poses', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS poses_session_time ON poses (session_id, time DESC);

-- Occupancy grid snapshots (every ~5 s, and only when the map changed).
-- data = zlib(int8 cells, row-major), the same layout as nav_msgs/OccupancyGrid.
CREATE TABLE IF NOT EXISTS map_snapshots (
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    time        timestamptz NOT NULL,
    width       int  NOT NULL,
    height      int  NOT NULL,
    resolution  real NOT NULL,                -- metres per cell
    origin_x    double precision NOT NULL,
    origin_y    double precision NOT NULL,
    data        bytea NOT NULL,
    PRIMARY KEY (session_id, time)
);

-- Gas field estimates (every ~10 s). mean/std = zlib(float32 LE, row-major) on the grid below.
CREATE TABLE IF NOT EXISTS field_estimates (
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    time        timestamptz NOT NULL,
    width       int  NOT NULL,
    height      int  NOT NULL,
    resolution  real NOT NULL,
    origin_x    double precision NOT NULL,
    origin_y    double precision NOT NULL,
    mean        bytea NOT NULL,
    std         bytea NOT NULL,
    model       jsonb,                        -- kernel hyperparameters, n_points, fit time
    PRIMARY KEY (session_id, time)
);

CREATE TABLE IF NOT EXISTS alerts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    time        timestamptz NOT NULL,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    wearer_id   text NOT NULL DEFAULT 'w1',
    kind        text NOT NULL CHECK (kind IN ('sample_over_threshold', 'field_danger_zone')),
    x           double precision NOT NULL,
    y           double precision NOT NULL,
    value       real NOT NULL,                -- voc reading, or P(voc > threshold) for zones
    acked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS alerts_session_time ON alerts (session_id, time DESC);

-- Per-cell gas stats in 10 s buckets on a 0.25 m grid.
-- Used for the per-cell fallback estimator, the replay heatmap, and plume drift over time.
-- materialized_only = false: queries also include rows that are not materialized yet.
CREATE MATERIALIZED VIEW IF NOT EXISTS gas_cells_10s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '10 seconds', time) AS bucket,
       session_id,
       floor(x / 0.25)::int AS cell_x,
       floor(y / 0.25)::int AS cell_y,
       avg(voc)  AS voc_avg,
       max(voc)  AS voc_max,
       count(*)  AS n
FROM gas_samples
GROUP BY bucket, session_id, cell_x, cell_y
WITH NO DATA;

SELECT add_continuous_aggregate_policy('gas_cells_10s',
    start_offset      => INTERVAL '1 hour',
    end_offset        => INTERVAL '10 seconds',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists     => TRUE);
