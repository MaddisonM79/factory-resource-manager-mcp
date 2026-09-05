import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyReport, roleOf, siteOf } from "../../src/frm/emergency.ts";

const group = (id: number, circuits: number[], o: Partial<Record<string, number | boolean | string>> = {}) => ({
  CircuitGroupID: id, AssociatedCircuits: circuits, PowerCapacity: 0, PowerProduction: 0, PowerConsumed: 0,
  BatteryPercent: 0, BatteryCapacity: 0, BatteryInput: 0, BatteryOutput: 0, BatteryTimeEmpty: "00:00:00", BatteryTimeFull: "00:00:00", FuseTriggered: false, ...o,
});
const sw = (name: string, on: boolean, primary: number, secondary: number) => ({ ID: `S-${name}`, Name: name, SwitchTag: name, IsOn: on, Primary: primary, Secondary: secondary, location: { x: 0, y: 0, z: 0 } });

const GRID = group(2, [3], { PowerCapacity: 39750, PowerProduction: 39750, PowerConsumed: 9344, BatteryPercent: 100, BatteryCapacity: 8000 });

test("names: suffix decides the role, the prefix is the site", () => {
  assert.equal(roleOf("COAST-EMERGENCY-RESERVE"), "reserve");
  assert.equal(roleOf("coast-tie"), "tie");
  assert.equal(roleOf("Main Switch"), null);
  assert.equal(siteOf("COAST-EMERGENCY-RESERVE"), "COAST");
  assert.equal(siteOf("east plant-TIE"), "EAST PLANT");
});

test("a held-back, full reserve with no tie built yet is still ready", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26)], [GRID, group(1, [26], { BatteryPercent: 99.96, BatteryCapacity: 8000 })]);
  assert.equal(r.ready, true);
  assert.equal(r.sites[0].ok, true);
  assert.deepEqual(r.sites[0].notes, ["no *-TIE switch for this site yet"]);
});

test("a held-back, full reserve with an open tie is ready and in normal mode", () => {
  const reserve = group(1, [26], { BatteryPercent: 99.96, BatteryCapacity: 8000 });
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("COAST-TIE", false, 3, 5)], [GRID, reserve, group(0, [5])]);
  assert.equal(r.mode, "normal");
  assert.equal(r.ready, true);
  assert.equal(r.mainGroup, 2);
  assert.equal(r.sites.length, 1);
  const s = r.sites[0];
  assert.equal(s.site, "COAST");
  assert.equal(s.reserve?.reserve?.group, 1, "the isolated side is the reserve");
  assert.equal(s.reserve?.reserve?.batteryMWh, 8000);
  assert.deepEqual(s.issues, []);
});

test("issues: closed reserve, low battery, discharging, missing tie, closed tie", () => {
  const low = group(1, [26], { BatteryPercent: 40, BatteryCapacity: 8000, BatteryOutput: 120, BatteryTimeEmpty: "01:30:00", PowerConsumed: 120 });
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("EAST-EMERGENCY-RESERVE", true, 3, 3), sw("EAST-TIE", true, 3, 9)], [GRID, low, group(0, [9])]);
  assert.equal(r.ready, false);
  const coast = r.sites.find((s) => s.site === "COAST")!;
  assert.ok(coast.issues.some((i) => i.includes("below 95%")), coast.issues.join(" | "));
  assert.ok(coast.issues.some((i) => i.includes("discharging")), coast.issues.join(" | "));
  assert.ok(coast.issues.some((i) => i.includes("load on the isolated side")));
  assert.ok(coast.notes.some((i) => i.includes("no *-TIE")), "a missing tie is a note, not an issue");
  const east = r.sites.find((s) => s.site === "EAST")!;
  assert.equal(east.reserve?.isOn, true);
  assert.equal(east.reserve?.reserve, null, "closed switch: both sides are one group, nothing behind it");
  assert.ok(east.reserve?.issues.some((i) => i.includes("bridged")));
  assert.ok(east.tie?.issues.some((i) => i.includes("bridged")));
  assert.equal(r.mode, "mixed", "one reserve closed, one open");
});

test("dark-restart mode: every reserve closed", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", true, 3, 26), sw("COAST-TIE", false, 3, 5)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 80 }), group(0, [5])]);
  assert.equal(r.mode, "dark-restart");
  assert.equal(r.ready, false);
});

test("a closed tie in normal mode is an issue and blocks readiness", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 3, 26), sw("COAST-TIE", true, 3, 5)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 100 }), group(0, [5])]);
  assert.equal(r.mode, "normal");
  assert.equal(r.ready, false);
  assert.ok(r.sites[0].issues.some((i) => i.includes("tie is closed")));
});

test("a side with no cable (circuit -1) is a note, not an issue", () => {
  const r = emergencyReport([sw("COAST-EMERGENCY-RESERVE", false, 0, 26), sw("COAST-TIE", false, -1, 0)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 100 }), group(0, [0])]);
  assert.equal(r.ready, true);
  assert.deepEqual(r.sites[0].notes, ["nothing wired to the primary side yet"]);
});

test("no matching switches: mode none, others listed", () => {
  const r = emergencyReport([sw("Main Switch", true, 3, 3)], [GRID]);
  assert.equal(r.mode, "none");
  assert.equal(r.switches.length, 0);
  assert.deepEqual(r.otherSwitches.map((s) => s.name), ["Main Switch"]);
});

test("min charge threshold is tunable", () => {
  const r = emergencyReport([sw("X-EMERGENCY-RESERVE", false, 3, 26)], [GRID, group(1, [26], { BatteryCapacity: 8000, BatteryPercent: 90 })], { minChargePct: 80 });
  assert.equal(r.switches[0].ok, true);
});
