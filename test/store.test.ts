import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./d1.ts";
import { snapshot, station, train, sink, machine, M } from "./fixtures.ts";
import { buildTick, gapState, initialState, HOUR, RAW_RETENTION_SECONDS, type HistoryState } from "../src/history.ts";
import { writeTick, writeGap, rollup, readSeries, readVisits, listLookup, updateLookup, rollupCutoff } from "../src/store.ts";

const T0 = 1_700_000_000;

/** Drive the sampler the way runTick does, against the fake D1. */
async function drive(db: D1Database, ticks: ({ ts: number } & ({ gap: string } | { snap: Parameters<typeof snapshot>[0] }))[], state = initialState()) {
  for (const t of ticks) {
    if ("gap" in t) { await writeGap(db, state, t.ts, t.gap); state = gapState(state); continue; }
    const tick = buildTick(snapshot({ ...t.snap, t: t.ts * 1000 }), state, t.ts);
    await writeTick(db, tick);
    state = tick.state;
  }
  return state;
}

test("a good tick writes every table in one batch; a gap tick writes only gap_samples", async () => {
  const db = d1();
  await drive(db, [{ ts: T0, snap: {} }, { ts: T0 + 300, gap: "FRM origin unreachable (530)" }]);
  for (const t of ["power_samples", "site_samples", "gen_samples", "depot_samples", "prod_samples", "station_samples", "sink_samples"]) {
    assert.equal(db.count(t), db.count(t, "ts = ?", T0), `${t}: nothing written on the gap tick`);
    assert.ok(db.count(t) > 0, `${t} has rows`);
  }
  assert.deepEqual(db.rows("SELECT ts, epoch, reason FROM gap_samples"), [{ ts: T0 + 300, epoch: 1, reason: "FRM origin unreachable (530)" }]);
  assert.equal(db.count("sites", "x IS NOT NULL"), 2, "lookup coordinates seeded from the first tick");
});

test("gaps are reported, never interpolated: no points at gap ticks, rates restart after the gap", async () => {
  const db = d1();
  await drive(db, [
    { ts: T0, snap: { sink: sink(1000) } },
    { ts: T0 + 300, snap: { sink: sink(1600), play: 1300 } },
    { ts: T0 + 600, gap: "down" },
    { ts: T0 + 900, gap: "down" },
    { ts: T0 + 1200, snap: { sink: sink(9000), play: 2200 } },
    { ts: T0 + 1500, snap: { sink: sink(9300), play: 2500 } },
  ]);
  const [s] = await readSeries(db, { kind: "sinks", from: T0, to: T0 + 1500, res: "raw" });
  assert.equal(s.epoch, 1);
  assert.deepEqual(s.gaps, [{ from: T0 + 600, to: T0 + 900 }]);
  assert.deepEqual(s.points.map((p) => [p.ts, p.points_per_min]), [
    [T0, null], [T0 + 300, 120], [T0 + 1200, null], [T0 + 1500, 60],
  ]);
});

test("series split per epoch across a save reload", async () => {
  const db = d1();
  await drive(db, [
    { ts: T0, snap: { play: 1000 } }, { ts: T0 + 300, snap: { play: 1300 } },
    { ts: T0 + 600, snap: { play: 100 } }, { ts: T0 + 900, snap: { play: 400 } },
  ]);
  const out = await readSeries(db, { kind: "power", from: T0, to: T0 + 900, res: "raw" });
  assert.deepEqual(out.map((s) => [s.epoch, s.points.length]), [[1, 2], [2, 2]]);
});

test("train visits: opened on dock, closed on departure with delta_cargo; visible through /api/visits", async () => {
  const db = d1();
  const S = (cargo: number, docked: boolean) => ({ stations: [station("Iron Out", cargo)], trains: docked ? [train("T1", "Iron Out", true)] : [train("T1", "Elsewhere", false)] });
  await drive(db, [
    { ts: T0, snap: { ...S(100, false) } },
    { ts: T0 + 300, snap: { ...S(400, true), play: 1300 } },
    { ts: T0 + 600, snap: { ...S(250, true), play: 1600 } },
    { ts: T0 + 900, snap: { ...S(40, false), play: 1900 } },
  ]);
  const visits = await readVisits(db, { from: T0, to: T0 + 900 });
  assert.equal(visits.length, 1);
  assert.equal(visits[0].station, "Iron Out"); assert.equal(visits[0].train, "T1");
  assert.equal(visits[0].arrived_ts, T0 + 300); assert.equal(visits[0].departed_ts, T0 + 900);
  assert.equal(visits[0].delta_cargo, 360, "cargo at arrival (400) minus at departure (40)");
  assert.deepEqual((await readVisits(db, { from: T0, to: T0 + 900, train: "nope" })), []);
  const [st] = await readSeries(db, { kind: "station", key: "iron out", from: T0, to: T0 + 900, res: "raw" });
  assert.deepEqual(st.points.map((p) => p.docked_train), [null, "T1", "T1", null]);
});

test("a visit open when the origin goes down is left open, not closed at the first sample after the gap", async () => {
  const db = d1();
  await drive(db, [
    { ts: T0, snap: { stations: [station("S", 100)], trains: [train("T1", "S", true)] } },
    { ts: T0 + 300, gap: "down" },
    { ts: T0 + 600, snap: { play: 1600, stations: [station("S", 5)], trains: [] } },
  ]);
  assert.deepEqual(db.rows("SELECT departed_ts, delta_cargo FROM train_visits"), [{ departed_ts: null, delta_cargo: null }]);
});

test("rollup is idempotent, keeps gap rows, counts gaps into the bucket, and deletes rolled raw rows", async () => {
  const db = d1();
  const now = T0 + 30 * 24 * HOUR;
  const cutoff = rollupCutoff(now);
  assert.equal(cutoff, Math.floor((now - RAW_RETENTION_SECONDS) / HOUR) * HOUR);
  // Two hourly buckets well before the cutoff (one with a gap in it), plus one recent tick that must survive.
  const old = cutoff - 5 * HOUR;
  await drive(db, [
    { ts: old, snap: { power: [{ CircuitGroupID: 1, PowerCapacity: 100, PowerConsumed: 10, BatteryCapacity: 1, BatteryPercent: 20 }], play: 1000 } },
    { ts: old + 300, snap: { power: [{ CircuitGroupID: 1, PowerCapacity: 100, PowerConsumed: 30, BatteryCapacity: 1, BatteryPercent: 40 }], play: 1300 } },
    { ts: old + 600, gap: "down" },
    { ts: old + HOUR, snap: { power: [{ CircuitGroupID: 1, PowerCapacity: 100, PowerConsumed: 50, BatteryCapacity: 1, BatteryPercent: 60 }], play: 5000, cloud: [{ Name: "Iron Plate", Amount: 10, MaxAmount: 100 }] } },
    { ts: old + HOUR + 300, snap: { power: [{ CircuitGroupID: 1, PowerCapacity: 100, PowerConsumed: 70, BatteryCapacity: 1, BatteryPercent: 80 }], play: 5300, cloud: [{ Name: "Iron Plate", Amount: 90, MaxAmount: 100 }] } },
    { ts: now - 300, snap: { play: 99_000 } },
  ]);
  const snapshotHourly = () => db.rows("SELECT * FROM hourly_power ORDER BY bucket_ts, circuit_group");

  await rollup(db, now, false);
  const first = snapshotHourly();
  await rollup(db, now, false);
  assert.deepEqual(snapshotHourly(), first, "re-running over the same raw rows rewrites identical hourly rows");
  await rollup(db, now);
  assert.deepEqual(snapshotHourly(), first, "the deleting run yields the same rows");
  await rollup(db, now);
  assert.deepEqual(snapshotHourly(), first, "a run with nothing left to roll changes nothing");

  assert.equal(first.length, 2);
  assert.deepEqual(first.map((r) => [r.sample_count, r.gap_count, r.consumed_mw, r.battery_pct]), [[2, 1, 20, 30], [2, 0, 60, 70]]);
  assert.equal(db.count("gap_samples"), 1, "gap rows are never rolled or deleted");
  assert.equal(db.count("power_samples"), 1, "only the recent raw tick remains");
  assert.deepEqual(db.rows("SELECT stock, stock_min, stock_max, is_full FROM hourly_depot WHERE bucket_ts = ?", old + HOUR), [{ stock: 50, stock_min: 10, stock_max: 90, is_full: 0 }]);
  for (const t of ["hourly_site", "hourly_gen", "hourly_prod", "hourly_station", "hourly_sink"]) assert.ok(db.count(t) > 0, `${t} rolled`);
  assert.equal(db.count("hourly_gen", "field_id = 0"), 4, "map-wide rows per fuel type, per bucket");
  assert.equal(db.count("hourly_gen", "field_id = -1"), 4, "cluster rows (resolved on read), per bucket");

  const out = await readSeries(db, { kind: "power", from: old - HOUR, to: now, res: "hourly" });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].points.map((p) => [p.ts, p.sample_count, p.gap_count]), [[old, 2, 1], [old + HOUR, 2, 0]]);
  assert.deepEqual(out[0].gaps, [{ from: old + 600, to: old + 600 }]);
});

test("site and field series resolve clusters by nearest center; unresolved clusters come back with id null", async () => {
  const db = d1();
  // Three sites; the lookup table has coordinates for two of them.
  const factory = [machine(0, 0), machine(10 * M, 0), machine(5000 * M, 0), machine(-5000 * M, -5000 * M)];
  await drive(db, [{ ts: T0, snap: { factory } }, { ts: T0 + 300, snap: { factory, play: 1300 } }]);
  // Seeding filled sites 1..3 in size order; blank site 3 so one cluster is unresolvable, and rename site 1.
  db.prepare("UPDATE sites SET x = NULL, y = NULL, z = NULL WHERE id = 3").run();
  assert.equal((await updateLookup(db, "sites", 1, { name: "Iron Row" }))?.name, "Iron Row");
  assert.equal((await listLookup(db, "sites")).find((s) => s.id === 1)?.name, "Iron Row");

  const [s1] = await readSeries(db, { kind: "site", key: "1", from: T0, to: T0 + 300, res: "raw" });
  assert.deepEqual(s1.points.map((p) => [p.ts, p.site_id, p.machines]), [[T0, 1, 2], [T0 + 300, 1, 2]]);

  const [all] = await readSeries(db, { kind: "site", key: "all", from: T0, to: T0, res: "raw" });
  const ids = all.points.map((p) => p.site_id).sort((a: any, b: any) => (a ?? 99) - (b ?? 99));
  assert.deepEqual(ids, [1, 2, null]);
  const unresolved = all.points.find((p) => p.site_id === null)!;
  assert.ok(typeof unresolved.center_x === "number", "raw center is returned for the unresolved cluster");

  await assert.rejects(readSeries(db, { kind: "site", key: "42", from: T0, to: T0, res: "raw" }), /unknown site/);
  assert.deepEqual(await readSeries(db, { kind: "site", key: "3", from: T0, to: T0, res: "raw" }), [], "a lookup row without coordinates matches nothing");

  const [gAll] = await readSeries(db, { kind: "gens", from: T0, to: T0, res: "raw" });
  assert.deepEqual(gAll.points.map((p) => [p.fuel_type, p.field_id, p.total]), [["Coal", 0, 2], ["Fuel", 0, 1]]);
  const [g1] = await readSeries(db, { kind: "gens", key: "1", from: T0, to: T0, res: "raw" });
  assert.deepEqual(g1.points.map((p) => [p.fuel_type, p.field_id, p.total]), [["Coal", 1, 2]]);
});

test("hourly site rows are merged per bucket after resolution", async () => {
  const db = d1();
  const now = T0 + 30 * 24 * HOUR;
  const old = rollupCutoff(now) - 3 * HOUR;
  // A cluster whose center straddles a 100 m cell boundary between ticks: two hourly rows, one site.
  await drive(db, [
    { ts: old, snap: { factory: [machine(99 * M, 0), machine(99 * M, 0)], play: 1 } },
    { ts: old + 300, snap: { factory: [machine(101 * M, 0), machine(101 * M, 0)], play: 2 } },
  ]);
  await rollup(db, now);
  assert.equal(db.count("hourly_site"), 2);
  const [s] = await readSeries(db, { kind: "site", key: "1", from: old, to: now, res: "hourly" });
  assert.equal(s.points.length, 1);
  assert.equal(s.points[0].sample_count, 2);
  assert.equal(s.points[0].machines, 2);
});
