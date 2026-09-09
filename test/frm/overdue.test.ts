import { test } from "node:test";
import assert from "node:assert/strict";
import { trainRows, trainsReport, applyOverdue, overdueOf, OVERDUE_FLOOR_S, OVERDUE_NO_BASELINE_S, type TrainRow } from "../../src/frm/trains.ts";
import type { TrainCadence } from "../../src/history/store.ts";

const NOW = 1_700_100_000;
const raw = (o: Record<string, unknown> = {}) => ({
  ID: "T", Name: "T1", Status: "Self-Driving", ForwardSpeed: 0, Docking: "TDS_None", TrainStation: "B", Derailed: false,
  TimeTable: [{ StationName: "A" }, { StationName: "B" }], TimeTableIndex: 1, SelfDriving: "SDLE_NoError", Path: "PDE_NoError", Vehicles: [], ...o,
});
const row = (o: Record<string, unknown> = {}): TrainRow => trainRows([raw(o)])[0];
const cad = (o: Partial<TrainCadence> = {}): TrainCadence => ({ train: "T1", last_arrival: NOW - 3000, intervals: 5, usual_s: 20 * 60, gap_s: 0, ...o });

test("a stuck train (speed 0, no FRM error) is overdue once past twice its usual dock interval", () => {
  // usual 12 min -> twice that is 24 min, so the 30 min floor applies
  const short = cad({ usual_s: 12 * 60 });
  assert.equal(overdueOf(row(), { ...short, last_arrival: NOW - 29 * 60 }, NOW, true), null);
  const o = overdueOf(row(), { ...short, last_arrival: NOW - 31 * 60 }, NOW, true);
  assert.ok(o); assert.equal(o.threshold_s, OVERDUE_FLOOR_S); assert.equal(o.usual_s, 12 * 60); assert.equal(o.since_s, 31 * 60);
  // usual 43 min -> threshold 86 min, above the floor
  assert.equal(overdueOf(row(), cad({ usual_s: 43 * 60, last_arrival: NOW - 80 * 60 }), NOW, true), null);
  assert.ok(overdueOf(row(), cad({ usual_s: 43 * 60, last_arrival: NOW - 90 * 60 }), NOW, true));
});

test("sampler gaps after the last dock do not count: the origin was down, not the train", () => {
  const c = cad({ last_arrival: NOW - 50 * 60, gap_s: 25 * 60 });
  assert.equal(overdueOf(row(), c, NOW, true), null, "50 min elapsed minus 25 min of gaps is under the 30 min floor");
  assert.ok(overdueOf(row(), { ...c, gap_s: 10 * 60 }, NOW, true));
});

test("no baseline: flat hour; no cadence at all: flagged only when the sampler is recording other trains", () => {
  const c = cad({ usual_s: null, intervals: 1, last_arrival: NOW - 59 * 60 });
  assert.equal(overdueOf(row(), c, NOW, true), null);
  const o = overdueOf(row(), { ...c, last_arrival: NOW - 61 * 60 }, NOW, true);
  assert.ok(o); assert.equal(o.threshold_s, OVERDUE_NO_BASELINE_S); assert.equal(o.usual_s, null);
  assert.equal(overdueOf(row(), undefined, NOW, false), null, "fresh database: nothing to compare against");
  const absent = overdueOf(row(), undefined, NOW, true);
  assert.ok(absent); assert.equal(absent.last_arrival, null);
});

test("docked, derailed, manual, and timetable-less trains are never overdue", () => {
  const late = cad({ last_arrival: NOW - 5 * 3600 });
  assert.equal(overdueOf(row({ Docking: "TDS_Docked" }), late, NOW, true), null);
  assert.equal(overdueOf(row({ Derailed: true }), late, NOW, true), null, "derailed is its own error");
  assert.equal(overdueOf(row({ Status: "Manual Driving" }), late, NOW, true), null);
  assert.equal(overdueOf(row({ TimeTable: [] }), late, NOW, true), null, "'no timetable' is its own error");
  assert.ok(overdueOf(row(), late, NOW, true));
});

test("applyOverdue stamps the field, appends a readable error line, and counts", () => {
  const report = trainsReport([raw(), raw({ ID: "U", Name: "T2", Docking: "TDS_Docked" })], []);
  const out = applyOverdue(report, { T1: cad({ usual_s: 43 * 60, last_arrival: NOW - 165 * 60 }) }, NOW, true);
  assert.equal(out.counts.overdue, 1);
  const t1 = out.trains.find((t) => t.name === "T1")!, t2 = out.trains.find((t) => t.name === "T2")!;
  assert.deepEqual(t1.errors, ["overdue: no dock for 2h45m (usual 43m)"]);
  assert.equal(t1.overdue?.since_s, 165 * 60);
  assert.equal(t2.overdue, null); assert.deepEqual(t2.errors, []);
  assert.deepEqual(report.trains.map((t) => t.errors), [[], []], "input report untouched");
});
