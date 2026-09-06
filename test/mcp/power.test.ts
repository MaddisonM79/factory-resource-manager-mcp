import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeGenerators } from "../../src/mcp/tools/power.ts";
import { generator, nuclear } from "../fixtures.ts";
import { fuelTypeOf } from "../../src/history/history.ts";

test("summarizeGenerators: per circuit group and per fuel; load, dry, empty water, waste and warnings", () => {
  const onG1 = (g: any, load = 100) => ({ ...g, LoadPercentage: load, PowerInfo: { CircuitGroupID: 1, FuseTriggered: false } });
  const onG2 = (g: any) => ({ ...g, PowerInfo: { CircuitGroupID: 2, FuseTriggered: false } });
  const thirsty = onG1({ ...generator(0, 0), Supplement: { Name: "Water", PercentFull: 0 } }, 0);
  const gens = [
    onG1(generator(0, 0), 80), onG1(generator(0, 0, "Build_GeneratorCoal_C", 0), 0), thirsty,
    onG2(nuclear(0, 0, 40, "Waste Full")), onG2({ ...nuclear(0, 0), PowerShards: 2 }),
  ];
  const byGroup = summarizeGenerators(gens, (g) => String(g.PowerInfo.CircuitGroupID));
  assert.deepEqual([byGroup["1"].total, byGroup["1"].fueled, byGroup["1"].dry, byGroup["1"].avgLoadPct, byGroup["1"].supplementEmpty], [3, 2, 1, 26.7, 1]);
  assert.equal(byGroup["1"].waste, 0);
  assert.equal(byGroup["2"].waste, 40);
  assert.equal(byGroup["2"].powerShards, 2);
  assert.deepEqual(byGroup["2"].warnings.map((w) => w.warning), ["Waste Full"]);
  const byFuel = summarizeGenerators(gens, fuelTypeOf);
  assert.deepEqual(Object.keys(byFuel).sort(), ["Coal", "Nuclear"]);
  assert.equal(byFuel.Nuclear.capacityMW, 5000);
});
