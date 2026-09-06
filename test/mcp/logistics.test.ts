import { test } from "node:test";
import assert from "node:assert/strict";
import { counterReport } from "../../src/mcp/tools/logistics.ts";
import { counter } from "../fixtures.ts";

const belt = (id: string, cls: string, a: [number, number, number], b: [number, number, number]) => ({
  ID: id, ClassName: cls, location0: { x: a[0], y: a[1], z: a[2] }, Connected0: true, location1: { x: b[0], y: b[1], z: b[2] }, Connected1: true,
  SplineData: [{ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: 0 }], Length: 1000, ItemsPerMinute: cls.includes("Mk3") ? 270 : 60,
});
const box = (x: number, y: number) => ({ min: { x: x - 200, y: y - 200, z: -100 }, max: { x: x + 200, y: y + 200, z: 100 } });

test("counters snap to the nearest belt, report utilisation against the cap, and name the machine the belt feeds", () => {
  const belts = [belt("B1", "Build_ConveyorBeltMk3_C", [0, 0, 0], [2000, 0, 0]), belt("B2", "Build_ConveyorBeltMk1_C", [0, 5000, 0], [2000, 5000, 0])];
  const smelter = { ID: "M1", Name: "Smelter", Recipe: "Iron Ingot", BoundingBox: box(2100, 0) };
  const rows = counterReport([counter("CM-1", 1000, 0, 260), counter("CM-2", 1000, 5000, 20, { cap: 60, confidence: 30 }), counter("CM-3", 90_000, 0, 5)], belts, [smelter], 95);
  assert.deepEqual(rows.map((r) => [r.id, r.beltId, r.capPerMin, r.utilizationPct, r.saturated]), [["CM-1", "B1", 270, 96.3, true], ["CM-2", "B2", 60, 33.3, false], ["CM-3", null, 270, 1.9, false]]);
  assert.equal(rows[0].feeds, "Smelter (Iron Ingot) M1");
  assert.equal(rows[0].drains, null);
  assert.equal(rows[2].beltTier, 3, "unmatched counter still knows its belt tier from FRM's Belt.ClassName");
});

test("a saturated counter needs confidence: a full belt FRM is unsure about is not flagged", () => {
  const [r] = counterReport([counter("CM-1", 0, 0, 270, { confidence: 20 })], [], [], 95);
  assert.equal(r.utilizationPct, 100);
  assert.equal(r.saturated, false);
});
