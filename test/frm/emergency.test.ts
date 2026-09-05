import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyReport, roleOf, siteOf } from "../../src/frm/emergency.ts";

const group = (id: number, circuits: number[], o: Partial<Record<string, number | boolean | string>> = {}) => ({
  CircuitGroupID: id, AssociatedCircuits: circuits, PowerCapacity: 0, PowerProduction: 0, PowerConsumed: 0,
  BatteryPercent: 0, BatteryCapacity: 0, BatteryInput: 0, BatteryOutput: 0, BatteryTimeEmpty: "00:00:00", BatteryTimeFull: "00:00:00", FuseTriggered: false, ...o,
});
const sw = (name: string, on: boolean, primary: number, secondary: number) => ({ ID: `S-${name}`, Name: name, SwitchTag: name, IsOn: on, Primary: primary, Secondary: secondary, location: { x: 0, y: 0, z: 0 } });

const GRID = group(2, [3], { PowerCapacity: 39750, PowerProduction: 39750, PowerConsumed: 9344, BatteryPercent: 100, BatteryCapacity: 8000 });
const BANK = group(1, [26], { BatteryPercent: 99.96, BatteryCapacity: 8000 });

test("names: suffix decides the role, the prefix is the site", () => {
  assert.equal(roleOf("COAST-EMERGENCY-RESERVE"), "reserve");
  assert.equal(roleOf("coast-tie"), "tie");
  assert.equal(roleOf("Main Switch"), null);
  assert.equal(siteOf("COAST-EMERGENCY-RESERVE"), "COAST");
  assert.equal(siteOf("east plant-TIE"), "EAST PLANT");
});

test("normal: reserve off with a full bank behind it, tie on", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("COAST-TIE", true, 3, 5)], [GRID, BANK, group(0, [5])]);
  assert.equal(r.mode, "normal");
  assert.equal(r.ready, true);
  assert.equal(r.mainGroup, 2);
  const s = r.sites[0];
  assert.equal(s.site, "COAST");
  assert.equal(s.reserve?.expectedOn, false);
  assert.equal(s.tie?.expectedOn, true);
  assert.equal(s.reserve?.reserve?.group, 1, "the isolated side is the bank");
  assert.equal(s.reserve?.reserve?.batteryMWh, 8000);
  assert.equal(s.reserve?.reserve?.storedMWh, 7996.8, "pct × size");
  assert.deepEqual(s.issues, []);
  assert.deepEqual(s.notes, []);
});

test("no tie built yet: a note, and the site is still ready", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26)], [GRID, BANK]);
  assert.equal(r.ready, true);
  assert.equal(r.sites[0].ok, true);
  assert.deepEqual(r.sites[0].notes, ["no *-TIE switch for this site yet"]);
});

test("a side with no cable (circuit -1) is a note", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 7, 26), sw("COAST-TIE", true, -1, 7)], [GRID, BANK, group(0, [7])]);
  assert.equal(r.ready, true);
  assert.deepEqual(r.sites[0].notes, ["nothing wired to the primary side yet"]);
});

test("an off switch whose sides share a power group is bypassed by another path: a note, and the tie does not isolate", () => {
  // Live shape seen on 2026-09-05: COAST-TIE IsOn=false, Primary=0, Secondary=0, with circuit 0 the main grid.
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 0, 26), sw("COAST-TIE", false, 0, 0)], [group(3, [0], { PowerCapacity: 39500, BatteryCapacity: 8000, BatteryPercent: 100 }), BANK]);
  const tie = r.sites[0].tie!;
  assert.equal(tie.isOn, false, "IsOn is the truth");
  assert.equal(tie.sidesJoined, true);
  assert.ok(tie.notes.some((n) => n.includes("another cable path")), tie.notes.join(" | "));
  assert.ok(tie.issues.some((i) => i.includes("tie is off")));
  assert.equal(r.mode, "mixed");
});

test("an on switch joins its two circuits into one power group", () => {
  // COAST-TIE on: Primary 0, Secondary 6, group 0 lists both.
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 0, 26), sw("COAST-TIE", true, 0, 6)], [group(0, [0, 6], { PowerCapacity: 39250, BatteryCapacity: 8000, BatteryPercent: 100 }), group(2, [26], { BatteryCapacity: 8000, BatteryPercent: 99.96 })]);
  const tie = r.sites[0].tie!;
  assert.equal(tie.isOn, true);
  assert.equal(tie.sidesJoined, true);
  assert.deepEqual(tie.notes, []);
  assert.equal(r.mode, "normal");
  assert.equal(r.ready, true);
  assert.equal(r.sites[0].reserve?.reserve?.group, 2);
});

test("the bank is the isolated side with a battery, even when the grid-side circuit is also off-main", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 7, 26)], [GRID, BANK, group(0, [7])]);
  assert.equal(r.sites[0].reserve?.reserve?.group, 1);
});

test("issues: reserve on, low bank, discharging, loaded, tie off", () => {
  const low = group(1, [26], { BatteryPercent: 40, BatteryCapacity: 8000, BatteryOutput: 120, BatteryTimeEmpty: "01:30:00", PowerConsumed: 120 });
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("EAST-EMERGENCY-RESERVE", true, 3, 3), sw("EAST-TIE", false, 3, 9)], [GRID, low, group(0, [9])]);
  assert.equal(r.ready, false);
  const coast = r.sites.find((s) => s.site === "COAST")!;
  assert.ok(coast.issues.some((i) => i.includes("below 95%")), coast.issues.join(" | "));
  assert.ok(coast.issues.some((i) => i.includes("discharging")));
  assert.ok(coast.issues.some((i) => i.includes("load on the isolated side")));
  const east = r.sites.find((s) => s.site === "EAST")!;
  assert.equal(east.reserve?.reserve, null, "switch on: both sides are one group, nothing behind it");
  assert.ok(east.reserve?.issues.some((i) => i.includes("bridged")));
  assert.ok(east.tie?.issues.some((i) => i.includes("cut off")));
  assert.equal(r.mode, "mixed", "one reserve on, one off");
});

test("dark-restart: every reserve on and every tie off", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", true, 3, 26), sw("COAST-TIE", false, 3, 5)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 80 }), group(0, [5])]);
  assert.equal(r.mode, "dark-restart");
  assert.equal(r.ready, false);
});

test("a tie off in normal mode is an issue and blocks readiness", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("COAST-TIE", false, 3, 5)], [GRID, BANK, group(0, [5])]);
  assert.equal(r.mode, "mixed");
  assert.equal(r.ready, false);
  assert.ok(r.sites[0].issues.some((i) => i.includes("tie is off")));
});

test("no matching switches: mode none, others listed", () => {
  const r = emergencyReport([sw("Main Switch", true, 3, 3)], [GRID]);
  assert.equal(r.mode, "none");
  assert.deepEqual(r.otherSwitches.map((s) => s.name), ["Main Switch"]);
});

test("min charge threshold is tunable", () => {
  const r = emergencyReport([sw("X-EMERGENCY-RESERVE", false, 3, 26)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 90 })], { minChargePct: 80 });
  assert.equal(r.switches[0].ok, true);
});
