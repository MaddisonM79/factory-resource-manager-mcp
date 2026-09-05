import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextEpoch, cluster, resolveCenter, stepVisits, coalesceGaps, pickRes, buildTick, gapState, initialState,
  siteRows, genRows, RAW_RETENTION_SECONDS, HOUR,
} from "../../src/history/history.ts";
import { fuelTypeOf, isFueled, fuelAmount, genCapacityMw } from "../../src/history/history.ts";
import { snapshot, machine, generator, station, train, sink, M } from "../fixtures.ts";

test("epoch: first sample is epoch 1, then bumps on session change or playtime regression", () => {
  assert.deepEqual(nextEpoch(null, { session: "A", playtime: 10 }), { epoch: 1, bumped: true });
  const prev = { session: "A", playtime: 100, epoch: 1 };
  assert.deepEqual(nextEpoch(prev, { session: "A", playtime: 400 }), { epoch: 1, bumped: false });
  assert.deepEqual(nextEpoch(prev, { session: "A", playtime: 100 }), { epoch: 1, bumped: false }, "equal playtime (paused game) is not a reload");
  assert.deepEqual(nextEpoch(prev, { session: "B", playtime: 400 }), { epoch: 2, bumped: true });
  assert.deepEqual(nextEpoch(prev, { session: "A", playtime: 99 }), { epoch: 2, bumped: true });
});

test("buildTick: epoch boundary drops rates and open visits; a continuous tick keeps them", () => {
  const s0 = initialState();
  const t1 = buildTick(snapshot({ play: 1000, stations: [station("Iron Out", 100)], trains: [train("T1", "Iron Out", true)] }), s0, 1000);
  assert.equal(t1.key.epoch, 1);
  assert.equal(t1.state.visits["Iron Out"].train, "T1");
  assert.equal(t1.sink[0].points_per_min, null, "no previous tick, no rate");

  const t2 = buildTick(snapshot({ play: 1300, sink: sink(10_600), stations: [station("Iron Out", 100)], trains: [train("T1", "Iron Out", true)] }), t1.state, 1300);
  assert.equal(t2.key.epoch, 1);
  assert.equal(t2.epochBumped, false);
  assert.equal(t2.sink[0].points_per_min, 120, "600 points over 300 s");
  assert.equal(t2.visitOpens.length, 0, "still docked, no new visit");

  // Save reload: playtime goes backwards. New epoch, no rate, visit re-opened rather than continued.
  const t3 = buildTick(snapshot({ play: 200, sink: sink(20_000), stations: [station("Iron Out", 100)], trains: [train("T1", "Iron Out", true)] }), t2.state, 1600);
  assert.equal(t3.key.epoch, 2);
  assert.equal(t3.epochBumped, true);
  assert.equal(t3.sink[0].points_per_min, null);
  assert.equal(t3.visitCloses.length, 0, "nothing is closed across an epoch boundary");
  assert.deepEqual(t3.visitOpens, [{ station: "Iron Out", train: "T1", arrived_ts: 1600 }]);

  // Session name change is also a boundary.
  const t4 = buildTick(snapshot({ name: "Save B", play: 5000 }), t3.state, 1900);
  assert.equal(t4.key.epoch, 3);
});

test("gap: state after a gap keeps the epoch but forbids continuation", () => {
  const t1 = buildTick(snapshot({ stations: [station("S", 10)], trains: [train("T", "S", true)] }), initialState(), 1000);
  const g = gapState(t1.state);
  assert.equal(g.epoch, 1);
  assert.equal(g.lastGood, false);
  assert.deepEqual(g.visits, {});
  const t2 = buildTick(snapshot({ play: 2000, sink: sink(99_999), stations: [station("S", 10)], trains: [] }), g, 1600);
  assert.equal(t2.key.epoch, 1, "same save continuing after downtime is the same epoch");
  assert.equal(t2.sink[0].points_per_min, null, "no rate across a gap");
  assert.equal(t2.visitCloses.length, 0, "a visit open before the gap is not closed after it");
});

test("train visits: open on dock, close on undock with delta_cargo = arrival - departure; swap closes and opens", () => {
  const r1 = stepVisits({}, [{ station: "S", docked: "T1", cargo: 500 }], 100);
  assert.deepEqual(r1.opens, [{ station: "S", train: "T1", arrived_ts: 100 }]);
  assert.equal(r1.closes.length, 0);

  const r2 = stepVisits(r1.visits, [{ station: "S", docked: "T1", cargo: 300 }], 400);
  assert.equal(r2.opens.length + r2.closes.length, 0, "still docked");

  const r3 = stepVisits(r2.visits, [{ station: "S", docked: null, cargo: 120 }], 700);
  assert.deepEqual(r3.closes, [{ station: "S", train: "T1", arrived_ts: 100, departed_ts: 700, delta_cargo: 380 }]);
  assert.deepEqual(r3.visits, {});

  const r4 = stepVisits(r1.visits, [{ station: "S", docked: "T2", cargo: 450 }], 400);
  assert.equal(r4.closes[0].train, "T1");
  assert.equal(r4.closes[0].delta_cargo, 50);
  assert.deepEqual(r4.opens, [{ station: "S", train: "T2", arrived_ts: 400 }]);
  assert.equal(r4.visits.S.train, "T2");
});

test("clustering matches site_status: 200 m radius, running-mean centers", () => {
  const pts = [
    { p: { x: 0, y: 0, z: 0 }, item: "a" }, { p: { x: 100 * M, y: 0, z: 0 }, item: "b" },
    { p: { x: 190 * M, y: 0, z: 0 }, item: "c" }, { p: { x: 1000 * M, y: 0, z: 0 }, item: "d" },
  ];
  const cs = cluster(pts, 200 * M);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0].members, ["a", "b", "c"]);
  assert.equal(Math.round(cs[0].cx / M), Math.round((0 + 100 + 190) / 3));
});

test("nearest-center resolution: nearest within 200 m wins, beyond it is unresolved, blank lookups are skipped", () => {
  const lookup = [
    { id: 1, name: "Iron", x: 0, y: 0, z: 0 },
    { id: 2, name: "Copper", x: 150 * M, y: 0, z: 0 },
    { id: 3, name: "Unseeded", x: null, y: null, z: null },
  ];
  assert.equal(resolveCenter({ x: 10 * M, y: 0 }, lookup), 1);
  assert.equal(resolveCenter({ x: 100 * M, y: 0 }, lookup), 2, "nearest, not first");
  assert.equal(resolveCenter({ x: 150 * M, y: 199 * M }, lookup), 2);
  assert.equal(resolveCenter({ x: 150 * M, y: 201 * M }, lookup), null, "outside every radius");
  assert.equal(resolveCenter({ x: 9999 * M, y: 9999 * M }, lookup), null);
});

test("siteRows and genRows: states, per-field rows plus map-wide rows", () => {
  const sites = siteRows([machine(0, 0), machine(10 * M, 0, { IsProducing: false, out: 100 }), machine(10_000 * M, 0, { IsProducing: false, ingr: 0 })], [{ CircuitGroupID: 1, PowerCapacity: 100 }]);
  assert.equal(sites.length, 2);
  assert.equal(sites[0].machines, 2); assert.equal(sites[0].running, 1); assert.equal(sites[0].blocked, 1);
  assert.equal(sites[1].starved, 1);

  const gens = genRows([generator(0, 0), generator(10 * M, 0, "Build_GeneratorCoal_C", 0), generator(10_000 * M, 0, "Build_GeneratorFuel_C", 5)]);
  const fields = gens.filter((g) => g.field_id === null), mapWide = gens.filter((g) => g.field_id === 0);
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.map((g) => [g.fuel_type, g.total, g.fueled, g.dry]), [["Coal", 2, 1, 1], ["Fuel", 1, 1, 0]]);
  assert.deepEqual(mapWide.map((g) => [g.fuel_type, g.total, g.capacity_mw]), [["Coal", 2, 150], ["Fuel", 1, 75]]);
});

test("generator fuel state from live FRM fields; AvailableFuel is never mistaken for stock", () => {
  const dry = { ClassName: "Build_GeneratorFuel_C", FuelAmount: 0, CanStart: false, IsFullSpeed: true, LoadPercentage: 100, FuelInventory: [],
    AvailableFuel: [{ Name: "Fuel", Amount: 0 }, { Name: "Turbofuel", Amount: 0 }], ProductionCapacity: 250, BaseProd: 250 };
  assert.equal(isFueled(dry), false);
  assert.equal(fuelAmount(dry), 0);
  assert.equal(isFueled({ ...dry, FuelAmount: 0.11 }), true, "fuel in the tank");
  assert.equal(isFueled({ ...dry, CanStart: true }), true, "empty tank but the game says it can start (fuel arriving)");
  assert.equal(fuelTypeOf(dry), "Fuel");
  assert.equal(genCapacityMw(dry), 250);
  const hub = { ClassName: "Build_GeneratorIntegratedBiomass_C", FuelAmount: 0, CanStart: false, FuelResource: "Geothermal",
    AvailableFuel: [{ Name: "Leaves", Amount: 15 }, { Name: "Wood", Amount: 100 }], ProductionCapacity: 20 };
  assert.equal(fuelTypeOf(hub), "Biomass");
  assert.equal(isFueled(hub), false, "AvailableFuel amounts are energy values of accepted fuels, not stock");
  assert.equal(fuelTypeOf({ ClassName: "Build_GeneratorGeoThermal_C" }), "Geothermal");
  assert.equal(isFueled({ ClassName: "Build_GeneratorGeoThermal_C", CanStart: false }), true);
  assert.equal(fuelAmount({ ClassName: "Build_GeneratorCoal_C", FuelInventory: [{ Name: "Coal", Amount: 7 }] }), 7, "solid fuel item list");
});

test("first live tick seeds lookup coordinates, largest clusters first, once", () => {
  const t1 = buildTick(snapshot(), initialState(), 1000);
  assert.equal(t1.seedSites.length, 2);
  assert.equal(Math.round(t1.seedSites[0].x / M), 25, "two-machine cluster comes first");
  assert.equal(t1.seedFields.length, 2);
  assert.equal(t1.state.seeded, true);
  const t2 = buildTick(snapshot(), t1.state, 1300);
  assert.equal(t2.seedSites.length + t2.seedFields.length, 0);
});

test("gap coalescing and resolution selection", () => {
  assert.deepEqual(coalesceGaps([300, 600, 900, 5000, 5300]), [{ from: 300, to: 900 }, { from: 5000, to: 5300 }]);
  const now = 10_000_000;
  assert.equal(pickRes(now - 3600, now, now), "raw");
  assert.equal(pickRes(now - RAW_RETENTION_SECONDS, now, now), "raw");
  assert.equal(pickRes(now - RAW_RETENTION_SECONDS - 2 * HOUR, now, now), "hourly", "more than 7 days");
  assert.equal(pickRes(now - 30 * 24 * HOUR, now - 29 * 24 * HOUR, now), "hourly", "short window but outside raw retention");
  assert.equal(pickRes(now - 30 * 24 * HOUR, now, now, "raw"), "raw", "explicit wins");
});
