import { test } from "node:test";
import assert from "node:assert/strict";
import { pipeReport, pipeTier, pipeCapM3PerMin } from "../../src/mcp/pipes.ts";

const box = (x: number, y: number, z: number, half = 120) => ({ min: { x: x - half, y: y - half, z: z - 75 }, max: { x: x + half, y: y + half, z: z + 75 } });
const pipe = (id: string, cls: string, a: [number, number, number], b: [number, number, number], c0: boolean, c1: boolean) => ({
  ID: id, Name: cls.includes("MK2") ? "Pipeline Mk.2" : "Pipeline Mk.1", ClassName: cls,
  location0: { x: a[0], y: a[1], z: a[2] }, Connected0: c0, location1: { x: b[0], y: b[1], z: b[2] }, Connected1: c1,
  Length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Speed: cls.includes("MK2") ? 10 : 5,
});

test("tier and cap come from the class name and Speed", () => {
  assert.equal(pipeTier({ ClassName: "Build_PipelineMK2_C" }), 2);
  assert.equal(pipeTier({ ClassName: "Build_Pipeline_C" }), 1);
  assert.equal(pipeCapM3PerMin({ ClassName: "Build_PipelineMK2_C", Speed: 10 }), 600);
  assert.equal(pipeCapM3PerMin({ ClassName: "Build_Pipeline_C" }), 300, "falls back to the tier cap when Speed is missing");
});

test("a free end inside a junction box is a phantom connection; one in open air is an open end", () => {
  const junction = { ID: "J1", Name: "Pipeline T-Junction", BoundingBox: box(1000, 1000, 0) };
  const refinery = { ID: "R1", Name: "Refinery", BoundingBox: box(5000, 5000, 0, 500) };
  const pump = { ID: "V1", Name: "Valve", BoundingBox: box(9000, 9000, 0, 100) };
  const pipes = [
    // end 0 sits on the junction's face, flagged unconnected: the mod snapped it, the network did not.
    pipe("P-phantom", "Build_PipelineMK2_C", [1000, 1120, 0], [1000, 3000, 0], false, true),
    // end 1 sits at the refinery, unconnected.
    pipe("P-machine", "Build_Pipeline_C", [4000, 5000, 0], [4500, 5000, 0], true, false),
    // end 1 at a valve.
    pipe("P-valve", "Build_Pipeline_C", [8000, 9000, 0], [8900, 9000, 0], true, false),
    // genuinely open stub in the middle of nowhere.
    pipe("P-open", "Build_Pipeline_C", [20000, 20000, 0], [20700, 20000, 0], false, true),
    // fully connected.
    pipe("P-ok", "Build_PipelineMK2_C", [1000, 3000, 0], [1000, 6000, 0], true, true),
  ];
  const r = pipeReport(pipes, { junctions: [junction], pumps: [pump], machines: [refinery] });
  assert.equal(r.pipesConsidered, 5);
  assert.equal(r.junctions, 1);
  assert.deepEqual(r.tiers.map((t) => [t.tier, t.count, t.flowCapM3PerMin, t.dangling]), [[1, 3, 300, 3], [2, 2, 600, 1]]);
  assert.deepEqual(r.phantom.rows.map((d) => [d.pipe, d.at, d.building, d.freeEnd]), [
    ["P-phantom", "junction", "Pipeline T-Junction", "start"],
    ["P-machine", "machine", "Refinery", "end"],
    ["P-valve", "pump", "Valve", "end"],
  ]);
  assert.deepEqual(r.open.rows.map((d) => d.pipe), ["P-open"]);
});

test("bbox filter keeps pipes with either end inside; limit caps rows but not counts", () => {
  const pipes = Array.from({ length: 5 }, (_, i) => pipe(`P${i}`, "Build_Pipeline_C", [i * 1000, 0, 0], [i * 1000 + 500, 0, 0], false, false));
  const r = pipeReport(pipes, { junctions: [], pumps: [], machines: [] }, { bbox: { min_x: 900, min_y: -1, max_x: 3100, max_y: 1 }, limit: 2 });
  assert.equal(r.pipesConsidered, 3, "P1, P2, P3");
  assert.equal(r.open.count, 6, "two free ends each");
  assert.equal(r.open.rows.length, 2);
});
