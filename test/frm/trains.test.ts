import { test } from "node:test";
import assert from "node:assert/strict";
import { trainsReport } from "../../src/frm/trains.ts";

const wagon = (item: string, amount: number) => ({ Name: "Freight Car", ClassName: "BP_FreightWagon_C", TotalMass: 100000, PayloadMass: 70000, MaxPayloadMass: 70000, Inventory: [{ Name: item, Amount: amount, MaxAmount: 500 }] });
const loco = { Name: "Electric Locomotive", ClassName: "BP_Locomotive_C", TotalMass: 300000, PayloadMass: 0, MaxPayloadMass: 0, Inventory: [] };
const train = (name: string, o: Record<string, unknown> = {}) => ({
  ID: `T-${name}`, Name: name, ClassName: "BP_Train_C", location: { x: 1, y: 2, z: 3 }, TotalMass: 698393, PayloadMass: 278393, MaxPayloadMass: 280000,
  ForwardSpeed: 16.4, TrainStation: "HOME-IN", Derailed: false, PendingDerail: false, Status: "Self-Driving",
  TimeTable: [{ StationName: "CTS-OUT" }, { StationName: "HOME-IN" }], TimeTableIndex: 1, SelfDriving: "SDLE_NoError", Docking: "TDS_None", Path: "PDE_NoError",
  Vehicles: [loco, wagon("Quickwire", 16000), wagon("Quickwire", 15682)], PowerInfo: { FuseTriggered: false, PowerConsumed: 85.97 }, ...o,
});
const platform = (mode: string, item: string, amount: number, docking = "None") => ({ ID: "P", Name: "Freight Platform", LoadingMode: mode, LoadingStatus: "Idle", DockingStatus: docking, TransferRate: 0.4, Inventory: [{ Name: item, Amount: amount, MaxAmount: 200 }] });
const station = (name: string, platforms: unknown[]) => ({ ID: `S-${name}`, Name: name, location: { x: 0, y: 0, z: 0 }, TransferRate: 1.2, CargoInventory: platforms, PowerInfo: { FuseTriggered: false } });

test("trains: cargo rolled up across wagons, next stop from the timetable index, state derived", () => {
  const r = trainsReport([train("CTS-QUICKWIRE")], [station("CTS-OUT", [platform("Loading", "Quickwire", 9600)]), station("HOME-IN", [platform("Unloading", "Quickwire", 100)])]);
  const t = r.trains[0];
  assert.equal(t.state, "moving");
  assert.equal(t.nextStop, "HOME-IN");
  assert.deepEqual(t.cargo, [{ name: "Quickwire", amount: 31682 }]);
  assert.equal(t.cars, 3);
  assert.equal(t.locomotives, 1);
  assert.equal(t.payloadPct, 99);
  assert.equal(t.payloadT, 278);
  assert.deepEqual(t.errors, []);
  assert.equal(r.counts.moving, 1);
});

test("stations: platforms with mode and stock, scheduled trains from timetables, inbound vs docked", () => {
  const trains = [train("A"), train("B", { Docking: "TDS_Docked", TrainStation: "CTS-OUT", ForwardSpeed: 0 })];
  const r = trainsReport(trains, [station("CTS-OUT", [platform("Loading", "Quickwire", 9600, "Docked"), platform("Loading", "Rubber", 200)]), station("HOME-IN", [platform("Unloading", "Quickwire", 100)]), station("LONELY", [])]);
  const cts = r.stations.find((s) => s.name === "CTS-OUT")!;
  assert.equal(cts.platforms.length, 2);
  assert.equal(cts.platforms[0].mode, "load");
  assert.equal(cts.stock, 9800);
  assert.deepEqual(cts.topItems.map((i) => i.name), ["Quickwire", "Rubber"]);
  assert.equal(cts.docked, "B");
  assert.deepEqual(cts.scheduled, ["A", "B"]);
  const home = r.stations.find((s) => s.name === "HOME-IN")!;
  assert.deepEqual(home.inbound, ["A"], "A reports HOME-IN as its station but is not docked");
  assert.equal(home.platforms[0].mode, "unload");
  assert.deepEqual(r.stations.find((s) => s.name === "LONELY")!.scheduled, []);
  assert.equal(r.counts.docked, 1);
  assert.equal(r.counts.platforms, 3);
});

test("errors: derailed, pending derail, autopilot and path errors, tripped fuse, empty timetable", () => {
  const r = trainsReport([train("BAD", { Derailed: true, PendingDerail: true, SelfDriving: "SDLE_NoPath", Path: "PDE_NoPath", PowerInfo: { FuseTriggered: true, PowerConsumed: 0 }, TimeTable: [], ForwardSpeed: 0 })], []);
  const t = r.trains[0];
  assert.equal(t.state, "derailed");
  assert.deepEqual(t.errors, ["derailed", "derail pending", "autopilot: NoPath", "path: NoPath", "fuse tripped", "no timetable"]);
  assert.equal(t.nextStop, null);
  assert.equal(r.counts.derailed, 1);
});
