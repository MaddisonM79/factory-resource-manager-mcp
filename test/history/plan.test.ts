// Every history read must hit an index. Records the SQL the store actually issues against the
// fake D1, then asks SQLite for the plan: a full SCAN of a sample table means a query drifted
// away from the (ts / bucket_ts / arrived_ts) indexes in migrations/0003.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "../d1.ts";
import { snapshot, sink } from "../fixtures.ts";
import { buildTick, initialState, RAW_RETENTION_SECONDS } from "../../src/history/history.ts";
import { writeTick, writeGap, rollup, readSeries, readVisits, readLatest, rollupStatus, type SeriesKind } from "../../src/history/store.ts";

const T0 = 1_700_000_000;
const TABLES = /\b(power|site|gen|depot|prod|station|sink|drone|counter|gap)_samples\b|\bhourly_\w+\b|\btrain_visits\b/;

/** Wrap prepare() so every statement's SQL is captured. */
function recording(db: ReturnType<typeof d1>) {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
  return seen;
}

function scans(db: ReturnType<typeof d1>, sql: string): string[] {
  // Bind placeholders to NULL: the plan does not depend on the values.
  const n = (sql.match(/\?/g) ?? []).length;
  const plan = db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...Array(n).fill(null));
  return plan.map((r) => r.detail).filter((d) => /^SCAN (\w+)/.test(d) && TABLES.test(d) && !/USING (COVERING )?INDEX/.test(d));
}

test("latest, series, visits, rollup and rollup status never full-scan a sample table", async () => {
  const db = d1();
  let state = initialState();
  for (let i = 0; i < 3; i++) {
    const tick = buildTick(snapshot({ sink: sink(1000 + i), t: (T0 + i * 300) * 1000 }), state, T0 + i * 300);
    await writeTick(db, tick);
    state = tick.state;
  }
  await writeGap(db, state, T0 + 900, "down");
  const now = T0 + RAW_RETENTION_SECONDS + 7200;
  const seen = recording(db);

  await readLatest(db);
  for (const kind of ["power", "site", "gens", "depot", "prod", "station", "sinks", "drone", "counter"] as SeriesKind[]) {
    for (const res of ["raw", "hourly"] as const) {
      await readSeries(db, { kind, from: T0, to: now, res, key: kind === "site" || kind === "gens" ? "all" : kind === "power" ? null : "x" });
    }
  }
  await readSeries(db, { kind: "site", from: T0, to: now, res: "raw", key: "1" });
  await readSeries(db, { kind: "gens", from: T0, to: now, res: "raw", key: "1" });
  await readVisits(db, { from: T0, to: now, station: "s" });
  await rollupStatus(db, now);
  await rollup(db, now);

  const offenders = seen
    .filter((sql) => /^\s*(SELECT|DELETE|INSERT OR REPLACE)/i.test(sql) && TABLES.test(sql) && !/COUNT\(\*\) AS n FROM|AS "table"/.test(sql))
    .flatMap((sql) => scans(db, sql).map((d) => `${d}\n    ${sql.replace(/\s+/g, " ").slice(0, 140)}`));
  assert.deepEqual(offenders, [], "full table scans:\n  " + offenders.join("\n  "));
});
