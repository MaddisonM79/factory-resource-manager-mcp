-- Every read filters on ts (or bucket_ts / arrived_ts) alone and nothing filters on session, so the
-- (session, ts) indexes from 0001/0002 were never used: SQLite cannot use a composite index without
-- its leading column, and EXPLAIN QUERY PLAN showed a full SCAN on every latest, series, visits and
-- rollup query. Replace them with single-column time indexes. Per-insert index maintenance is
-- unchanged (one index per table), and the entries no longer carry the session text.
-- Kept: the hourly UNIQUE keys (idempotent rollup), train_visits_open (close-visit UPDATE),
-- gap_samples_epoch_ts (rollup gap counts).

-- ---------------------------------------------------------------- raw
DROP INDEX power_samples_session_ts;    CREATE INDEX power_samples_ts    ON power_samples (ts);
DROP INDEX site_samples_session_ts;     CREATE INDEX site_samples_ts     ON site_samples (ts);
DROP INDEX gen_samples_session_ts;      CREATE INDEX gen_samples_ts      ON gen_samples (ts);
DROP INDEX depot_samples_session_ts;    CREATE INDEX depot_samples_ts    ON depot_samples (ts);
DROP INDEX prod_samples_session_ts;     CREATE INDEX prod_samples_ts     ON prod_samples (ts);
DROP INDEX station_samples_session_ts;  CREATE INDEX station_samples_ts  ON station_samples (ts);
DROP INDEX sink_samples_session_ts;     CREATE INDEX sink_samples_ts     ON sink_samples (ts);
DROP INDEX drone_samples_session_ts;    CREATE INDEX drone_samples_ts    ON drone_samples (ts);
DROP INDEX counter_samples_session_ts;  CREATE INDEX counter_samples_ts  ON counter_samples (ts);
DROP INDEX gap_samples_session_ts;      CREATE INDEX gap_samples_ts      ON gap_samples (ts);

-- Visits are read by arrival time; ts is only the tick that opened the row.
DROP INDEX train_visits_session_ts;     CREATE INDEX train_visits_arrived ON train_visits (arrived_ts);

-- ---------------------------------------------------------------- hourly
DROP INDEX hourly_power_session_ts;     CREATE INDEX hourly_power_bucket   ON hourly_power (bucket_ts);
DROP INDEX hourly_site_session_ts;      CREATE INDEX hourly_site_bucket    ON hourly_site (bucket_ts);
DROP INDEX hourly_gen_session_ts;       CREATE INDEX hourly_gen_bucket     ON hourly_gen (bucket_ts);
DROP INDEX hourly_depot_session_ts;     CREATE INDEX hourly_depot_bucket   ON hourly_depot (bucket_ts);
DROP INDEX hourly_prod_session_ts;      CREATE INDEX hourly_prod_bucket    ON hourly_prod (bucket_ts);
DROP INDEX hourly_station_session_ts;   CREATE INDEX hourly_station_bucket ON hourly_station (bucket_ts);
DROP INDEX hourly_sink_session_ts;      CREATE INDEX hourly_sink_bucket    ON hourly_sink (bucket_ts);
DROP INDEX hourly_drone_session_ts;     CREATE INDEX hourly_drone_bucket   ON hourly_drone (bucket_ts);
DROP INDEX hourly_counter_session_ts;   CREATE INDEX hourly_counter_bucket ON hourly_counter (bucket_ts);
