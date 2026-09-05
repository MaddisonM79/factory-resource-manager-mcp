// Pipe network checks. FRM's getPipes reports Connected0/Connected1 per segment; a free end
// whose point sits inside a junction's or building's bounding box is a "phantom" connection:
// it snapped visually but never joined the fluid network. That is the failure mode of
// mod-placed junction connectors, and it is invisible until a bank starves.

import { asArray, num, pt, inBox, loc, type Pt } from "../frm/client.ts";

export type EndKind = "junction" | "pump" | "machine" | "open";

export interface DanglingEnd {
  pipe: string;
  name: string;
  tier: number;
  freeEnd: "start" | "end";
  at: EndKind;
  /** what the free end is touching, when it is touching something */
  building?: string;
  buildingId?: string;
  location: string;
  lengthM: number;
}

export interface TierSummary { tier: number; count: number; flowCapM3PerMin: number; totalLengthM: number; dangling: number }

export interface PipeReport {
  pipesConsidered: number;
  junctions: number;
  tiers: TierSummary[];
  /** free ends touching a junction or building: almost certainly a snap that did not connect */
  phantom: { count: number; rows: DanglingEnd[] };
  /** free ends in open air: intentional stubs, or the far end of a phantom */
  open: { count: number; rows: DanglingEnd[] };
}

export const pipeTier = (p: any): number => (/MK2/i.test(String(p?.ClassName ?? "")) ? 2 : 1);

/** FRM `Speed` is m³/s (5 for Mk.1, 10 for Mk.2); the cap the game shows is per minute. */
export const pipeCapM3PerMin = (p: any): number => num(p?.Speed) * 60 || (pipeTier(p) === 2 ? 600 : 300);

/** Snap tolerance around a bounding box, cm. Pipe ends sit on the box face, not inside it. */
const PAD = 60;

export interface Buildings { junctions: any[]; pumps: any[]; machines: any[] }

export function classifyEnd(p: Pt, b: Buildings): { at: EndKind; hit?: any } {
  for (const j of b.junctions) if (inBox(p, j.BoundingBox, PAD)) return { at: "junction", hit: j };
  for (const m of b.pumps) if (inBox(p, m.BoundingBox, PAD)) return { at: "pump", hit: m };
  for (const m of b.machines) if (inBox(p, m.BoundingBox, PAD)) return { at: "machine", hit: m };
  return { at: "open" };
}

export interface PipeOpts { bbox?: { min_x: number; min_y: number; max_x: number; max_y: number }; limit?: number }

export function pipeReport(pipesRaw: unknown, buildings: Buildings, opts: PipeOpts = {}): PipeReport {
  const { bbox, limit = 50 } = opts;
  const inB = (p: any) => !bbox || (num(p?.x) >= bbox.min_x && num(p?.x) <= bbox.max_x && num(p?.y) >= bbox.min_y && num(p?.y) <= bbox.max_y);
  const pipes = asArray(pipesRaw).filter((p) => inB(p.location0) || inB(p.location1));
  const withBox = (list: any[]) => list.filter((x) => x?.BoundingBox);
  const b: Buildings = { junctions: withBox(buildings.junctions), pumps: withBox(buildings.pumps), machines: withBox(buildings.machines) };

  const tiers: Record<number, TierSummary> = {};
  const phantom: DanglingEnd[] = [];
  const open: DanglingEnd[] = [];
  for (const p of pipes) {
    const tier = pipeTier(p);
    const s = (tiers[tier] ??= { tier, count: 0, flowCapM3PerMin: pipeCapM3PerMin(p), totalLengthM: 0, dangling: 0 });
    s.count++;
    s.totalLengthM += num(p.Length) / 100;
    for (const [flag, key, which] of [["Connected0", "location0", "start"], ["Connected1", "location1", "end"]] as const) {
      if (p[flag] !== false) continue;
      const point = pt(p[key]);
      if (!point) continue;
      s.dangling++;
      const c = classifyEnd(point, b);
      const row: DanglingEnd = {
        pipe: String(p.ID), name: String(p.Name ?? ""), tier, freeEnd: which, at: c.at,
        building: c.hit ? String(c.hit.Name ?? c.hit.ClassName ?? "") : undefined,
        buildingId: c.hit ? String(c.hit.ID ?? "") : undefined,
        location: loc({ location: p[key] }), lengthM: Math.round(num(p.Length) / 100),
      };
      (c.at === "open" ? open : phantom).push(row);
    }
  }
  for (const s of Object.values(tiers)) s.totalLengthM = Math.round(s.totalLengthM);
  return {
    pipesConsidered: pipes.length,
    junctions: b.junctions.length,
    tiers: Object.values(tiers).sort((a, c) => a.tier - c.tier),
    phantom: { count: phantom.length, rows: phantom.slice(0, limit) },
    open: { count: open.length, rows: open.slice(0, limit) },
  };
}
