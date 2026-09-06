-- Drone ports, throughput counters, and generator load / nuclear waste.
-- Same conventions as 0001: raw rows keyed by (ts, session, playtime, epoch), hourly rows
-- keyed by (session, epoch, bucket_ts, <dimension>) so the rollup stays idempotent.

-- ---------------------------------------------------------------- generators: load and waste
ALTER TABLE gen_samples ADD COLUMN load_pct REAL;
ALTER TABLE gen_samples ADD COLUMN waste INTEGER;
ALTER TABLE hourly_gen ADD COLUMN load_pct REAL;
ALTER TABLE hourly_gen ADD COLUMN waste REAL;
ALTER TABLE hourly_gen ADD COLUMN waste_max INTEGER;

-- ---------------------------------------------------------------- drone ports (getDroneStation)
CREATE TABLE drone_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  station TEXT, paired TEXT, status TEXT,
  in_per_min REAL, out_per_min REAL, est_per_min REAL, round_trip_s REAL,
  trip_in REAL, trip_out REAL, fuel INTEGER, input_stock INTEGER, output_stock INTEGER
);
CREATE INDEX drone_samples_session_ts ON drone_samples (session, ts);

CREATE TABLE hourly_drone (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  station TEXT, paired TEXT, status TEXT,
  in_per_min REAL, out_per_min REAL, est_per_min REAL, round_trip_s REAL,
  trip_in REAL, trip_out REAL, fuel REAL, fuel_min INTEGER, input_stock REAL, output_stock REAL,
  UNIQUE (session, epoch, bucket_ts, station)
);
CREATE INDEX hourly_drone_session_ts ON hourly_drone (session, bucket_ts);

-- ---------------------------------------------------------------- throughput counters (getThroughputCounter)
CREATE TABLE counter_samples (
  ts INTEGER NOT NULL, session TEXT NOT NULL, playtime INTEGER NOT NULL, epoch INTEGER NOT NULL,
  counter_id TEXT, name TEXT, belt TEXT, cap_per_min REAL, items_per_min REAL, confidence REAL
);
CREATE INDEX counter_samples_session_ts ON counter_samples (session, ts);

CREATE TABLE hourly_counter (
  session TEXT NOT NULL, epoch INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
  sample_count INTEGER NOT NULL, gap_count INTEGER NOT NULL, playtime INTEGER NOT NULL,
  counter_id TEXT, name TEXT, belt TEXT, cap_per_min REAL,
  items_per_min REAL, items_min REAL, items_max REAL, confidence REAL,
  UNIQUE (session, epoch, bucket_ts, counter_id)
);
CREATE INDEX hourly_counter_session_ts ON hourly_counter (session, bucket_ts);
