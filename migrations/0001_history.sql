-- FRM history: raw 5-minute samples (7-day retention) + hourly aggregates (kept forever).
-- Every sample table carries (ts, session, playtime, epoch); see src/history.ts for the epoch guard.

-- ---------------------------------------------------------------- raw
CREATE TABLE power_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  circuit_group INTEGER, capacity_mw REAL, production_mw REAL, consumed_mw REAL, max_consumed_mw REAL,
  battery_pct REAL, battery_in_mw REAL, battery_out_mw REAL, fuse_tripped INTEGER
);
CREATE INDEX power_samples_session_ts ON power_samples (session, ts);

CREATE TABLE site_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  site_id INTEGER, center_x REAL, center_y REAL, center_z REAL,
  machines INTEGER, running INTEGER, blocked INTEGER, starved INTEGER, unpowered INTEGER,
  paused INTEGER, unconfigured INTEGER, idle INTEGER,
  mw_draw REAL, mw_max REAL, avg_productivity REAL
);
CREATE INDEX site_samples_session_ts ON site_samples (session, ts);

CREATE TABLE gen_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  fuel_type TEXT, field_id INTEGER, center_x REAL, center_y REAL, center_z REAL,
  total INTEGER, fueled INTEGER, dry INTEGER, capacity_mw REAL
);
CREATE INDEX gen_samples_session_ts ON gen_samples (session, ts);

CREATE TABLE depot_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  item TEXT, stock INTEGER, capacity INTEGER, is_full INTEGER
);
CREATE INDEX depot_samples_session_ts ON depot_samples (session, ts);

CREATE TABLE prod_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  item TEXT, produced_per_min REAL, consumed_per_min REAL, max_prod REAL, max_cons REAL
);
CREATE INDEX prod_samples_session_ts ON prod_samples (session, ts);

CREATE TABLE station_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  station TEXT, platform INTEGER, mode TEXT, cargo TEXT, transfer_rate REAL,
  docked_train TEXT, inbound INTEGER
);
CREATE INDEX station_samples_session_ts ON station_samples (session, ts);

CREATE TABLE train_visits (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  station TEXT, train TEXT, arrived_ts INTEGER, departed_ts INTEGER, delta_cargo INTEGER
);
CREATE INDEX train_visits_session_ts ON train_visits (session, ts);
CREATE INDEX train_visits_open ON train_visits (station, train, arrived_ts);

CREATE TABLE sink_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  sink TEXT, coupons INTEGER, points_to_next INTEGER, points_per_min REAL
);
CREATE INDEX sink_samples_session_ts ON sink_samples (session, ts);

-- One row per tick the origin was unreachable; nothing else is written that tick.
-- session/playtime are the last known values (or '' / 0 before any good sample).
CREATE TABLE gap_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX gap_samples_session_ts ON gap_samples (session, ts);
CREATE INDEX gap_samples_epoch_ts ON gap_samples (epoch, ts);

-- ---------------------------------------------------------------- hourly
-- Keyed by (session, epoch, bucket_ts, <dimension>). The unique index makes the rollup
-- idempotent: INSERT OR REPLACE from the same raw rows yields the same hourly rows.
CREATE TABLE hourly_power (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  circuit_group INTEGER, capacity_mw REAL, production_mw REAL, consumed_mw REAL, max_consumed_mw REAL,
  battery_pct REAL, battery_in_mw REAL, battery_out_mw REAL, fuse_tripped REAL,
  UNIQUE (session, epoch, bucket_ts, circuit_group)
);
CREATE INDEX hourly_power_session_ts ON hourly_power (session, bucket_ts);

-- Sites have no stable id; rows are grouped by a 100 m cell of the cluster center and
-- resolved to a `sites` row on read (nearest center within 200 m).
CREATE TABLE hourly_site (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  cell_x INTEGER, cell_y INTEGER, site_id INTEGER, center_x REAL, center_y REAL, center_z REAL,
  machines REAL, running REAL, running_min INTEGER, running_max INTEGER,
  blocked REAL, blocked_min INTEGER, blocked_max INTEGER,
  starved REAL, starved_min INTEGER, starved_max INTEGER,
  unpowered REAL, paused REAL, unconfigured REAL, idle REAL,
  mw_draw REAL, mw_max REAL, avg_productivity REAL,
  UNIQUE (session, epoch, bucket_ts, cell_x, cell_y)
);
CREATE INDEX hourly_site_session_ts ON hourly_site (session, bucket_ts);

CREATE TABLE hourly_gen (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  fuel_type TEXT, field_id INTEGER, cell_x INTEGER, cell_y INTEGER, center_x REAL, center_y REAL, center_z REAL,
  total REAL, fueled REAL, dry REAL, dry_min INTEGER, dry_max INTEGER, capacity_mw REAL,
  UNIQUE (session, epoch, bucket_ts, fuel_type, field_id, cell_x, cell_y)
);
CREATE INDEX hourly_gen_session_ts ON hourly_gen (session, bucket_ts);

CREATE TABLE hourly_depot (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  item TEXT, stock REAL, stock_min INTEGER, stock_max INTEGER, capacity REAL, is_full REAL,
  UNIQUE (session, epoch, bucket_ts, item)
);
CREATE INDEX hourly_depot_session_ts ON hourly_depot (session, bucket_ts);

CREATE TABLE hourly_prod (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  item TEXT, produced_per_min REAL, consumed_per_min REAL, max_prod REAL, max_cons REAL,
  UNIQUE (session, epoch, bucket_ts, item)
);
CREATE INDEX hourly_prod_session_ts ON hourly_prod (session, bucket_ts);

CREATE TABLE hourly_station (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  station TEXT, platform INTEGER, mode TEXT, transfer_rate REAL, docked REAL, inbound REAL,
  UNIQUE (session, epoch, bucket_ts, station, platform)
);
CREATE INDEX hourly_station_session_ts ON hourly_station (session, bucket_ts);

CREATE TABLE hourly_sink (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  sink TEXT, coupons REAL, coupons_max INTEGER, points_to_next REAL, points_per_min REAL,
  UNIQUE (session, epoch, bucket_ts, sink)
);
CREATE INDEX hourly_sink_session_ts ON hourly_sink (session, bucket_ts);

-- ---------------------------------------------------------------- lookups
-- Cluster centers in FRM map units (cm). Coordinates are NULL until the sampler seeds them
-- from the first live tick (largest clusters first); rename via PATCH /api/lookup/sites/:id.
CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL, x REAL, y REAL, z REAL);
CREATE TABLE fields (id INTEGER PRIMARY KEY, name TEXT NOT NULL, x REAL, y REAL, z REAL);

INSERT INTO sites (id, name) VALUES
  (1, 'Site 1'), (2, 'Site 2'), (3, 'Site 3'), (4, 'Site 4'), (5, 'Site 5'), (6, 'Site 6'),
  (7, 'Site 7'), (8, 'Site 8'), (9, 'Site 9'), (10, 'Site 10'), (11, 'Site 11');
INSERT INTO fields (id, name) VALUES
  (1, 'Field 1'), (2, 'Field 2'), (3, 'Field 3'), (4, 'Field 4');
