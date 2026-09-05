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
-- Cluster centers in FRM map units (cm), seeded from the live save on 2026-09-05 (site_status,
-- 200 m radius, largest cluster first). Names are guesses from the dominant recipes; rename via
-- PATCH /api/lookup/sites/:id. Rows whose coordinates are NULL get filled by the sampler's first
-- live tick, so extra rows can be added with just a name.
CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL, x REAL, y REAL, z REAL);
CREATE TABLE fields (id INTEGER PRIMARY KEY, name TEXT NOT NULL, x REAL, y REAL, z REAL);

INSERT INTO sites (id, name, x, y, z) VALUES
  (1,  'HOME Iron & Steel Parts',        -30859, 266598,  1100),   -- 69 machines: iron ingot, iron wire, steel cast plate
  (2,  'HOME Copper & Steel Pipe',       -60594, 263146,  1536),   -- 67: copper ingot, wire, steel pipe, solid steel
  (3,  'EAST Oil: Diluted Fuel',         147966, 210002, -4697),   -- 64: heavy oil residue, diluted fuel, residual plastic
  (4,  'Aluminum Plateau',                -5661,  38709, 24500),   -- 54: pure aluminum ingot, electrode scrap
  (5,  'Caterium / Quickwire',          -149300, 216600, -1600),   -- 48: quickwire, pure caterium ingot
  (6,  'COAST Oil: Fuel/Rubber/Plastic', -238787, 151418,  -700),   -- 39: fuel, rubber, plastic
  (7,  'HOME Copper Sheet & Wiring',     -79718, 228086,   938),   -- 29: steamed copper sheet, wire, automated wiring
  (8,  'HOME Biofuel',                   -33462, 242025, -1675),   -- 8: biomass, solid/liquid biofuel
  (9,  'Wet Concrete',                    26800, 252700,   300),   -- 8: wet concrete
  (10, 'Petroleum Coke',                  54400,   2300, 13600),   -- 8: heavy oil residue, petroleum coke
  (11, 'QZS Quartz & Silica',             49820, 206040, -4900);   -- 5: pure quartz crystal, cheap silica

-- Generator fields from getGenerators (177 fuel generators + 2 HUB biomass burners), same clustering.
INSERT INTO fields (id, name, x, y, z) VALUES
  (1, 'EAST Fuel Plant North',  112800, 237600,  -500),   -- 60 fuel generators
  (2, 'EAST Fuel Plant South',  143200, 179600, -3800),   -- 60 fuel generators
  (3, 'COAST Fuel Plant',      -259000, 175200,  -700),   -- 50 fuel generators
  (4, 'COAST Fuel Row',        -231000, 162200,  -700),   -- 5 fuel generators, 274 m from the plant so a cluster of its own
  (5, 'HUB Burners',            -35750, 241351, -2455);   -- 2 biomass burners + 2 fuel generators
