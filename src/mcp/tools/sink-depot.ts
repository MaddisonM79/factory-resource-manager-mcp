// AWESOME Sink and Dimensional Depot rates from the sampler history.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Env,
  frmGet,
  asArray,
  num,
  loc,
  round,
  takeSample,
  appendSample,
  windowOf,
  minutesBetween,
  iso,
} from "../../frm/client.ts";

import { guard, history } from "../shared.ts";

const sinkView = (s: any, then: { total: number; t: number } | null, now: number) => {
  if (!s) return null;
  const total = num(s.TotalPoints), toCoupon = num(s.PointsToCoupon);
  const mins = then ? minutesBetween(then.t, now) : 0;
  const rate = then && mins > 0 ? (total - then.total) / mins : null;
  return {
    coupons: num(s.NumCoupon),
    progressPct: round(num(s.Percent) * 100),
    pointsToCoupon: toCoupon,
    totalPoints: total,
    pointsPerMin: rate == null ? null : Math.round(rate),
    minutesToNextCoupon: rate && rate > 0 ? Math.round(toCoupon / rate) : null,
    trendMinutes: round(mins),
    graphPoints: asArray(s.GraphPoints),
  };
};


export function registerSinkDepot(server: McpServer, env: Env): void {
  server.registerTool(
    "sink_rates",
    {
      description:
        "AWESOME Sink: coupons, progress and points to the next coupon, points/min from the sampler history over window_minutes, ETA to next coupon, " +
        "the exploration sink, each sink building's power state, and optional point values per item from getSinkList. " +
        "FRM does not expose items/min per sink building; rates are global.",
      inputSchema: z.object({
        window_minutes: z.number().min(5).max(1440).default(60),
        item: z.string().optional().describe("substring; returns sink point values for matching items"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ window_minutes, item, limit }) =>
      guard(async () => {
        const [sample, sinkRaw, xsinkRaw, buildings, sinkList] = await Promise.all([
          takeSample(env),
          frmGet(env, "getResourceSink"),
          frmGet(env, "getExplorationSink").catch(() => null),
          frmGet(env, "getResourceSinkBuilding").catch(() => []),
          item ? frmGet(env, "getSinkList") : Promise.resolve([]),
        ]);
        const ring = await appendSample(env, sample);
        const w = windowOf(ring, window_minutes, sample.t);
        const oldest = (k: "sink" | "xsink") => { const o = w.samples.find((x) => x[k]); return o && o[k] ? { total: o[k]!.total, t: o.t } : null; };
        return {
          resourceSink: sinkView(asArray(sinkRaw)[0], oldest("sink"), sample.t),
          explorationSink: sinkView(asArray(xsinkRaw)[0], oldest("xsink"), sample.t),
          sinkBuildings: asArray(buildings).map((b) => ({ id: b.ID, location: loc(b), circuitGroup: b.PowerInfo?.CircuitGroupID, powered: num(b.PowerInfo?.PowerConsumed) > 0, fuseTripped: !!b.PowerInfo?.FuseTriggered })),
          pointValues: item
            ? asArray(sinkList).filter((x) => String(x.Name ?? "").toLowerCase().includes(item.toLowerCase())).slice(0, limit).map((x) => ({ item: x.Name, points: num(x.Points) }))
            : undefined,
          history: history(w, sample.t),
        };
      }),
  );

  server.registerTool(
    "depot_status",
    {
      description:
        "Dimensional Depot per item: stock, stack size, capacity (stack × depot expansion multiplier from M.A.M. research, inferred from the fullest items if research is unreadable), full or not, fill rate per minute " +
        "from the sampler history over window_minutes, minutes to full, and the time it filled if that happened inside the window. Answers 'what filled first'.",
      inputSchema: z.object({
        item: z.string().optional().describe("substring on item name"),
        only_full: z.boolean().default(false),
        window_minutes: z.number().min(5).max(1440).default(120),
        sort: z.enum(["fullest", "rate", "name"]).default("fullest"),
        limit: z.number().int().min(1).max(200).default(60),
      }),
    },
    async ({ item, only_full, window_minutes, sort, limit }) =>
      guard(async () => {
        const [sample, cloud, schematics] = await Promise.all([takeSample(env), frmGet(env, "getCloudInv"), frmGet(env, "getSchematics").catch(() => null)]);
        const ring = await appendSample(env, sample);
        const w = windowOf(ring, window_minutes, sample.t);
        const win = w.samples.filter((x) => x.cloud);
        const items = asArray(cloud);
        // "Depot Expansion (400%)" purchased => capacity is 4 stacks. Fall back to inferring from the fullest items.
        const researched = asArray(schematics)
          .filter((r) => r.Purchased && /Depot Expansion \((\d+)%\)/.test(String(r.Name)))
          .map((r) => num(String(r.Name).match(/(\d+)%/)![1]) / 100);
        const multSource = researched.length ? "research" : "inferred";
        const mult = researched.length
          ? Math.max(...researched)
          : Math.max(1, ...items.map((i) => (num(i.MaxAmount) ? Math.ceil(num(i.Amount) / num(i.MaxAmount)) : 1)));
        const oldest = win[0];
        const rows = items
          .filter((i) => !item || String(i.Name ?? "").toLowerCase().includes(item.toLowerCase()))
          .map((i) => {
            const name = String(i.Name), amount = num(i.Amount), stack = num(i.MaxAmount), cap = stack * mult;
            const full = cap > 0 && amount >= cap;
            const then = oldest?.cloud?.[name];
            const mins = oldest ? minutesBetween(oldest.t, sample.t) : 0;
            const rate = then != null && mins > 0 ? (amount - then) / mins : null;
            const filledSample = full ? win.find((x) => (x.cloud?.[name] ?? 0) >= cap) : undefined;
            return {
              item: name, amount, stack, capacity: cap, pct: cap ? Math.round((amount / cap) * 100) : null, full,
              ratePerMin: rate == null ? null : round(rate, 2),
              minutesToFull: !full && rate && rate > 0 ? Math.round((cap - amount) / rate) : null,
              filledAt: full ? (filledSample && filledSample !== win[0] ? iso(filledSample.t) : win.length ? "before window" : "unknown (no samples)") : null,
            };
          })
          .filter((r) => !only_full || r.full)
          .sort((a, b) =>
            sort === "name" ? a.item.localeCompare(b.item)
            : sort === "rate" ? Math.abs(b.ratePerMin ?? 0) - Math.abs(a.ratePerMin ?? 0) || (b.pct ?? 0) - (a.pct ?? 0) || a.item.localeCompare(b.item)
            : (b.pct ?? 0) - (a.pct ?? 0) || a.item.localeCompare(b.item));
        const changed = oldest ? items.filter((i) => (oldest.cloud?.[String(i.Name)] ?? num(i.Amount)) !== num(i.Amount)).length : null;
        return {
          items: rows.length, full: rows.filter((r) => r.full).length,
          depotStackMultiplier: mult, multiplierSource: multSource,
          history: { ...history(w, sample.t), itemsChangedInWindow: changed },
          rows: rows.slice(0, limit),
        };
      }),
  );
}
