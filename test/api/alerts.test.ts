import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlerts, STALE_SAMPLER_S, ROLLUP_LATE_S, type AlertInputs } from "../../src/api/alerts.ts";
import { trainRows, trainsReport, type TrainsReport } from "../../src/frm/trains.ts";

const NOW = 1_700_100_000;
const base = (o: Partial<AlertInputs> = {}): AlertInputs => ({
  now: NOW,
  origin: { reachable: true, error: null, uobjectsPct: 24.2 },
  sampler: { staleness_s: 120, gap: false },
  latest: null, trains: null, rollupAt: NOW - 3600,
  ...o,
});
const ids = (i: AlertInputs) => buildAlerts(i).map((a) => `${a.level}:${a.id}`);

test("a healthy factory has no alerts", () => {
  assert.deepEqual(buildAlerts(base()), []);
});

test("origin, sampler, object pool, and rollup rules", () => {
  assert.deepEqual(ids(base({ origin: { reachable: false, error: "530", uobjectsPct: null } })), ["bad:origin"]);
  assert.deepEqual(ids(base({ sampler: { staleness_s: STALE_SAMPLER_S + 1, gap: false } })), ["bad:sampler"]);
  assert.deepEqual(ids(base({ sampler: { staleness_s: 60, gap: true } })), ["bad:sampler"]);
  assert.deepEqual(ids(base({ origin: { reachable: true, error: null, uobjectsPct: 76 } })), ["warn:uobjects"]);
  assert.deepEqual(ids(base({ origin: { reachable: true, error: null, uobjectsPct: 91 } })), ["bad:uobjects"]);
  assert.deepEqual(ids(base({ rollupAt: NOW - ROLLUP_LATE_S - 1 })), ["warn:rollup"]);
  assert.deepEqual(ids(base({ rollupAt: null })), [], "never ran (fresh install) is not an alert");
});

test("trains: derailed, overdue, other errors, and invalid blocks; bad before warn", () => {
  const raw = (o: Record<string, unknown>) => ({ ID: o.Name, Status: "Self-Driving", ForwardSpeed: 0, Docking: "TDS_None", TrainStation: "B", TimeTable: [{ StationName: "A" }, { StationName: "B" }], TimeTableIndex: 1, SelfDriving: "SDLE_NoError", Path: "PDE_NoError", Vehicles: [], location: { x: 1, y: 2, z: 3 }, ...o });
  const report: TrainsReport = trainsReport(
    [raw({ Name: "D", Derailed: true }), raw({ Name: "P", Path: "PDE_NoPath" }), raw({ Name: "OK" })],
    [], [{ ID: "S1", Aspect: "RSA_Clear", BlockValid: "RBV_ContainsLoop" }],
  );
  const overdue = trainRows([raw({ Name: "O" })])[0];
  overdue.overdue = { since_s: 9900, usual_s: 2580, threshold_s: 5160, last_arrival: NOW - 9900 };
  overdue.errors = ["overdue: no dock for 2h45m (usual 43m)"];
  report.trains.push(overdue);
  const out = buildAlerts(base({ trains: report }));
  assert.deepEqual(out.map((a) => `${a.level}:${a.id}`), ["bad:train-derailed:D", "bad:train-error:P", "bad:train-overdue:O", "warn:signals"]);
  assert.equal(out[2].detail, "no dock for 2h45m (usual 43m) · heading to B");
  assert.equal(out[1].title, "P: path: NoPath");
});

test("power and generators from the latest tick: fuse, peak over capacity, dry share on map-wide rows only", () => {
  const latest: any = {
    ts: NOW, epoch: 1, session: "s", playtime: 1, gap: null, sites: [], depot: [], prod: [], stations: [], sinks: [], drones: [], counters: [],
    power: [
      { circuit_group: 0, capacity_mw: 40000, max_consumed_mw: 19000, fuse_tripped: 0 },
      { circuit_group: 1, capacity_mw: 100, max_consumed_mw: 120, fuse_tripped: 0 },
      { circuit_group: 2, capacity_mw: 100, max_consumed_mw: 300, fuse_tripped: 1 },
      { circuit_group: 3, capacity_mw: 0, max_consumed_mw: 1, fuse_tripped: 0 },
    ],
    gens: [
      { fuel_type: "Fuel", field_id: 0, total: 175, fueled: 167, dry: 8 },
      { fuel_type: "Coal", field_id: 0, total: 8, fueled: 4, dry: 4 },
      { fuel_type: "Biomass", field_id: 0, total: 2, fueled: 0, dry: 2 },
      { fuel_type: "Fuel", field_id: 3, total: 4, fueled: 0, dry: 4 },
    ],
  };
  assert.deepEqual(ids(base({ latest })), ["bad:fuse:2", "warn:peak:1", "warn:dry:Coal"]);
});
