// Power: per-circuit snapshot and the battery trend (KV ring, or D1 for windows past 24 h).

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Env,
  frmGet,
  asArray,
  matches,
  num,
  round,
  takeSample,
  appendSample,
  windowOf,
  minutesBetween,
  iso,
  type Sample,
} from "../../frm/client.ts";

import { querySeries } from "../../api/routes.ts";
import { emergencyReport } from "../../frm/emergency.ts";
import { guard, history } from "../shared.ts";

/** The KV ring covers 24 h; longer battery_trend windows are served from D1. */
const RING_MINUTES = 1440;

async function batteryTrendFromHistory(env: Env, windowMinutes: number, circuitGroup: number | undefined) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - windowMinutes * 60;
  const out = await querySeries(env, { kind: "power", key: circuitGroup != null ? String(circuitGroup) : null, from, to: now }, now);
  const all = Array.isArray(out) ? out : [out];
  // Only the newest epoch is a trend; older ones are a different save or session.
  const cur = all[all.length - 1];
  const byGroup = new Map<number, any[]>();
  for (const p of cur?.points ?? []) {
    const g = num(p.circuit_group);
    byGroup.set(g, [...(byGroup.get(g) ?? []), p]);
  }
  const first = cur?.points[0], last = cur?.points[cur.points.length - 1];
  const rows = [...byGroup].map(([g, pts]) => {
    const a = pts[0], b = pts[pts.length - 1];
    const spanMin = (num(b.ts) - num(a.ts)) / 60;
    const hasBattery = pts.some((p) => p.battery_pct != null);
    const dPct = hasBattery && a.battery_pct != null && b.battery_pct != null ? num(b.battery_pct) - num(a.battery_pct) : null;
    const rate = dPct != null && spanMin > 0 ? dPct / spanMin : null;
    const pcts = pts.map((p) => p.battery_pct).filter((v) => v != null).map(num);
    return {
      circuitGroup: g, matchedBy: "group" as const, hasBattery,
      now: { batteryPct: round(num(b.battery_pct)), inMW: round(num(b.battery_in_mw)), outMW: round(num(b.battery_out_mw)), productionMW: round(num(b.production_mw)), consumptionMW: round(num(b.consumed_mw)), capacityMW: round(num(b.capacity_mw)), fuseTripped: num(b.fuse_tripped) > 0, at: iso(num(b.ts) * 1000) },
      windowStart: { batteryPct: round(num(a.battery_pct)), productionMW: round(num(a.production_mw)), consumptionMW: round(num(a.consumed_mw)), at: iso(num(a.ts) * 1000) },
      deltaPct: dPct == null ? null : round(dPct),
      pctPerMin: rate == null ? null : round(rate, 3),
      minutesToEmpty: rate != null && rate < 0 ? Math.round(num(b.battery_pct) / -rate) : null,
      minutesToFull: rate != null && rate > 0 ? Math.round((100 - num(b.battery_pct)) / rate) : null,
      minPct: pcts.length ? round(Math.min(...pcts)) : null,
      maxPct: pcts.length ? round(Math.max(...pcts)) : null,
      deltaProductionMW: round(num(b.production_mw) - num(a.production_mw)),
      deltaConsumptionMW: round(num(b.consumed_mw) - num(a.consumed_mw)),
      fuseTrippedInWindow: pts.some((p) => num(p.fuse_tripped) > 0),
      samples: pts.length,
    };
  });
  return {
    windowMinutes, source: "d1", res: cur?.res ?? null, epoch: cur?.epoch ?? null,
    history: {
      samplesUsed: cur?.points.length ?? 0,
      spanMinutes: first && last ? round((num(last.ts) - num(first.ts)) / 60) : 0,
      oldestUsable: first ? iso(num(first.ts) * 1000) : null,
      truncatedBy: all.length > 1 ? "epoch" : null,
      truncatedAt: all.length > 1 && first ? iso(num(first.ts) * 1000) : null,
      gaps: cur?.gaps ?? [],
      olderEpochs: all.length > 1 ? all.slice(0, -1).map((s) => ({ epoch: s.epoch, session: s.session, points: s.points.length })) : undefined,
    },
    rows,
  };
}

export function registerPower(server: McpServer, env: Env): void {
  server.registerTool(
    "power_overview",
    {
      description: "Per-circuit power summary: capacity, production, consumption, max draw, headroom, battery state, tripped fuses.",
    },
    async () =>
      guard(async () => {
        const circuits = asArray(await frmGet(env, "getPower"));
        return circuits.map((c) => {
          const cap = num(c.PowerCapacity);
          const used = num(c.PowerConsumed);
          const max = num(c.PowerMaxConsumed);
          return {
            circuitGroup: c.CircuitGroupID ?? c.CircuitID,
            circuits: c.AssociatedCircuits,
            capacityMW: cap,
            productionMW: num(c.PowerProduction),
            consumedMW: used,
            maxConsumedMW: max,
            headroomMW: cap - max,
            utilizationPct: cap ? Math.round((used / cap) * 1000) / 10 : null,
            battery: num(c.BatteryCapacity)
              ? {
                  capacityMWh: num(c.BatteryCapacity),
                  percent: Math.round(num(c.BatteryPercent) * 10) / 10,
                  inMW: num(c.BatteryInput),
                  outMW: num(c.BatteryOutput),
                  timeToEmpty: c.BatteryTimeEmpty,
                  timeToFull: c.BatteryTimeFull,
                }
              : null,
            fuseTriggered: !!c.FuseTriggered,
          };
        });
      }),
  );

  server.registerTool(
    "battery_trend",
    {
      description:
        "Battery and power trend per circuit group over window_minutes, from the sampler history (cron every 5 min plus every call to a trend tool): " +
        "battery % now vs window start, %/min, projected minutes to empty or full at that rate, min/max in window, and production/consumption deltas. A trend, not a snapshot. " +
        "Group numbers are renumbered when you rewire, so history is matched by member circuit IDs; matchedBy tells you how, and 'none' means the grid is new since the window started. " +
        "Windows longer than the 24 h KV ring are answered from D1 history instead (raw 5-minute samples for 7 days, hourly beyond), matched by group number.",
      inputSchema: z.object({
        window_minutes: z.number().min(5).max(90 * 1440).default(30),
        circuit_group: z.number().int().optional(),
      }),
    },
    async ({ window_minutes, circuit_group }) =>
      guard(async () => {
        if (window_minutes > RING_MINUTES) return batteryTrendFromHistory(env, window_minutes, circuit_group);
        const sample = await takeSample(env);
        const ring = await appendSample(env, sample);
        const w = windowOf(ring, window_minutes, sample.t);
        const win = w.samples;
        const first = win[0] ?? sample;
        const spanMin = minutesBetween(first.t, sample.t);
        const rows = sample.power
          .filter((c) => circuit_group == null || c.g === circuit_group)
          .map((c) => {
            // Match by overlapping circuit IDs (stable across rewiring); fall back to group number for old samples without ids.
            const overlap = (x: Sample["power"][number]) => x.ids?.length && c.ids?.length ? x.ids.filter((i) => c.ids.includes(i)).length : 0;
            const pick = (ps: Sample["power"]) => {
              const best = ps.map((x) => ({ x, n: overlap(x) })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n)[0];
              if (best) return { x: best.x, by: "circuits" as const };
              // Old samples have no ids: accept the same group number only if the battery capacity also matches.
              const byG = ps.find((x) => x.g === c.g && !x.ids?.length && x.bcap === c.bcap);
              return byG ? { x: byG, by: "group" as const } : null;
            };
            const m0 = pick(first.power);
            const matchedBy: "circuits" | "group" | "none" = m0?.by ?? "none";
            const then = m0?.x ?? null;
            const hist = win.map((s) => pick(s.power)?.x).filter((x): x is Sample["power"][number] => !!x);
            const dPct = then ? c.bpct - then.bpct : null;
            const rate = then && spanMin > 0 ? (dPct as number) / spanMin : null;
            return {
              circuitGroup: c.g,
              circuits: c.ids,
              matchedBy,
              hasBattery: c.bcap > 0,
              now: { batteryPct: round(c.bpct), capacityMWh: c.bcap, inMW: round(c.bin), outMW: round(c.bout), productionMW: round(c.prod), consumptionMW: round(c.cons), capacityMW: round(c.cap), fuseTripped: c.fuse },
              windowStart: then ? { batteryPct: round(then.bpct), productionMW: round(then.prod), consumptionMW: round(then.cons), at: iso(first.t) } : null,
              deltaPct: dPct == null ? null : round(dPct),
              pctPerMin: rate == null ? null : round(rate, 3),
              minutesToEmpty: rate != null && rate < 0 ? Math.round(c.bpct / -rate) : null,
              minutesToFull: rate != null && rate > 0 ? Math.round((100 - c.bpct) / rate) : null,
              minPct: hist.length ? round(Math.min(...hist.map((h) => h.bpct))) : null,
              maxPct: hist.length ? round(Math.max(...hist.map((h) => h.bpct))) : null,
              deltaProductionMW: then ? round(c.prod - then.prod) : null,
              deltaConsumptionMW: then ? round(c.cons - then.cons) : null,
              fuseTrippedInWindow: hist.some((h) => h.fuse),
            };
          });
        return { windowMinutes: window_minutes, history: history(w, sample.t), rows };
      }),
  );

  server.registerTool(
    "emergency_reserve",
    {
      description:
        "Dark-restart readiness. Power switches named *-EMERGENCY-RESERVE gate a battery bank that must stay isolated (switch open) and full; " +
        "*-TIE switches are the cut-off from the main grid, also open in normal operation. Reports each site's switches, the circuit and battery behind each reserve " +
        "(charge %, MWh, in/out MW, time to empty or full, fuse), every deviation from the normal state as a plain issue, the overall mode " +
        "(normal, dark-restart in progress, mixed, none) and whether the reserves are ready. Live from getSwitches + getPower; nothing is sampled.",
      inputSchema: z.object({
        min_charge_pct: z.number().min(0).max(100).default(95).describe("a reserve battery below this is an issue"),
      }),
    },
    async ({ min_charge_pct }) =>
      guard(async () => {
        const [switches, power] = await Promise.all([frmGet(env, "getSwitches"), frmGet(env, "getPower")]);
        return emergencyReport(switches, power, { minChargePct: min_charge_pct });
      }),
  );
}
