// Logistics and transport networks: vehicles, stations, belts, pipes.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Env,
  frmGet,
  asArray,
  num,
  loc,
  pt,
  inBox,
  round,
  type Pt,
} from "../../frm/client.ts";

import { pipeReport } from "../pipes.ts";
import { signalRows } from "../../frm/trains.ts";
import { guard, inv } from "../shared.ts";

const BELT_CAP: Record<number, number> = { 1: 60, 2: 120, 3: 270, 4: 480, 5: 780, 6: 1200 };
const beltTier = (b: any) => num((String(b.ClassName ?? "").match(/Mk(\d)/) ?? [])[1]);

const countBy = <T,>(items: T[], keyOf: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) { const k = keyOf(i); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

/** A counter sits on a belt: the nearest belt whose spline (or an end) passes within this many cm. */
const COUNTER_SNAP_CM = 400;

export interface CounterReportRow {
  id: string; name: string;
  beltId: string | null; beltTier: number | null; capPerMin: number;
  measuredPerMin: number; utilizationPct: number | null; confidencePct: number;
  saturated: boolean;
  /** machine the belt feeds (its end) or drains (its start), when an end sits in a machine's bounding box */
  feeds: string | null; drains: string | null;
  location: string;
}

/**
 * Throughput counters (getThroughputCounter) matched to belts by position: FRM names the belt's class
 * and cap but not its ID. Measured flow is FRM's CalculatedAverage; Confidence is FRM's 0..100.
 */
export function counterReport(counters: any[], belts: any[], machines: any[], saturatedPct: number): CounterReportRow[] {
  const nearest = (p: Pt): any | null => {
    let best: any = null, bd = COUNTER_SNAP_CM;
    for (const b of belts) {
      const pts = [b.location0, b.location1, ...asArray(b.SplineData)].map(pt).filter((x): x is Pt => !!x);
      for (const q of pts) {
        const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        if (d < bd) { bd = d; best = b; }
      }
    }
    return best;
  };
  const machineAt = (p: Pt | null) => (p ? machines.find((m) => inBox(p, m.BoundingBox, 120)) : null);
  return counters.map((c) => {
    const p = pt(c);
    const belt = p ? nearest(p) : null;
    const cap = num(c.Belt?.ItemsPerMinute) || (belt ? num(belt.ItemsPerMinute) || BELT_CAP[beltTier(belt)] || 0 : 0);
    const measured = num(c.CalculatedAverage);
    const confidence = num(c.Confidence);
    const util = cap ? (measured / cap) * 100 : null;
    const feeds = belt ? machineAt(pt(belt.location1)) : null, drains = belt ? machineAt(pt(belt.location0)) : null;
    return {
      id: String(c.ID ?? ""), name: String(c.Name ?? ""),
      beltId: belt ? String(belt.ID) : null, beltTier: belt ? beltTier(belt) : (num((String(c.Belt?.ClassName ?? "").match(/Mk(\d)/) ?? [])[1]) || null),
      capPerMin: cap, measuredPerMin: round(measured, 2), utilizationPct: util == null ? null : round(util), confidencePct: round(confidence),
      saturated: util != null && util >= saturatedPct && confidence >= 50,
      feeds: feeds ? `${feeds.Name} (${feeds.Recipe ?? "no recipe"}) ${feeds.ID}` : null,
      drains: drains ? `${drains.Name} (${drains.Recipe ?? "no recipe"}) ${drains.ID}` : null,
      location: loc(c),
    };
  }).sort((a, b) => (b.utilizationPct ?? -1) - (a.utilizationPct ?? -1));
}

export function registerLogistics(server: McpServer, env: Env): void {
  server.registerTool(
    "logistics_status",
    {
      description:
        "Trains, drones, trucks and their stations: where each vehicle is, what it's carrying, per-platform load/unload state, and anything derailed or stuck. " +
        "Trains also bring rail signals: aspect (Clear/Stop/Dock) and block validity, invalid blocks first. " +
        "Drone ports carry FRM's own telemetry: status, averaged items/min in and out, estimated transport rate, round-trip times, items per trip, " +
        "and the active fuel's cost per trip, so 'is this route keeping up?' is answered with numbers.",
      inputSchema: z.object({
        include: z.array(z.enum(["trains", "drones", "trucks"])).default(["trains", "drones"]),
        limit: z.number().int().min(1).max(200).default(40),
      }),
    },
    async ({ include, limit }) =>
      guard(async () => {
        const out: Record<string, unknown> = {};
        if (include.includes("trains")) {
          const [trains, stations, signalsRaw] = await Promise.all([
            frmGet(env, "getTrains"), frmGet(env, "getTrainStation"), frmGet(env, "getTrainSignals").catch(() => null),
          ]);
          out.trains = asArray(trains).slice(0, limit).map((t) => {
            // Cargo lives on each wagon under Vehicles[].Inventory; roll it up by item.
            const cargo = new Map<string, number>();
            for (const v of asArray(t.Vehicles)) for (const i of inv(v.Inventory)) cargo.set(i.name, (cargo.get(i.name) ?? 0) + i.amount);
            return {
              name: t.Name,
              status: t.Status,
              speed: Math.round(num(t.ForwardSpeed)),
              derailed: !!t.Derailed,
              pendingDerail: !!t.PendingDerail,
              atStation: t.TrainStation,
              selfDriving: t.SelfDriving,
              docking: t.Docking,
              location: loc(t),
              timetable: asArray(t.TimeTable).map((s: any) => s.StationName ?? s.Name),
              cars: asArray(t.Vehicles).length,
              payloadPct: num(t.MaxPayloadMass) ? Math.round((num(t.PayloadMass) / num(t.MaxPayloadMass)) * 100) : null,
              cargo: [...cargo].map(([name, amount]) => ({ name, amount })),
            };
          });
          // Station cargo is nested: CargoInventory[] = freight platforms, each with its own Inventory + mode.
          out.trainStations = asArray(stations).slice(0, limit).map((s) => ({
            name: s.Name,
            location: loc(s),
            transferRate: s.TransferRate,
            platforms: asArray(s.CargoInventory).map((p: any) => ({
              mode: p.LoadingMode,
              status: p.LoadingStatus,
              docking: p.DockingStatus,
              inventory: inv(p.Inventory),
            })),
          }));
          const signals = signalRows(signalsRaw);
          const problems = signals.filter((s) => !s.blockOk || s.aspect === "Stop");
          out.signals = {
            total: signals.length,
            byAspect: countBy(signals, (s) => s.aspect),
            invalidBlocks: signals.filter((s) => !s.blockOk).length,
            rows: (problems.length ? problems : signals).slice(0, limit),
            note: signals.length ? (problems.length ? "rows are the invalid blocks and Stop aspects" : "every block is valid and no signal shows Stop; rows are all signals") : "no signals (none built, or FRM predates getTrainSignals)",
          };
        }
        if (include.includes("drones")) {
          const [drones, ports] = await Promise.all([frmGet(env, "getDrone"), frmGet(env, "getDroneStation")]);
          out.drones = asArray(drones).slice(0, limit).map((d) => ({
            name: d.Name,
            status: d.CurrentFlyingMode ?? d.Status,
            home: d.HomeStation,
            paired: d.PairedStation ?? d.Destination,
            destination: d.CurrentDestination ?? null,
            hasPairedStation: d.HasPairedStation ?? null,
            speed: round(num(d.FlyingSpeed)), maxSpeed: round(num(d.MaxSpeed)),
            location: loc(d),
          }));
          const fuel = (f: any) => f && f.FuelName ? {
            name: f.FuelName, perTrip: round(num(f.SingleTripFuelCost), 2), perMin: round(num(f.EstimatedFuelCostRate), 3),
            estItemsPerMin: round(num(f.EstimatedTransportRate), 2), estRoundTripS: round(num(f.EstimatedRoundTripTime)),
          } : null;
          out.droneStations = asArray(ports).slice(0, limit).map((p) => ({
            name: p.Name,
            paired: p.PairedStation === "None" ? null : p.PairedStation,
            status: p.DroneStatus ?? null,
            fuel: inv(p.FuelInventory),
            input: inv(p.InputInventory),
            output: inv(p.OutputInventory),
            // FRM's averaged rates for this port (items/min) and per-trip amounts.
            rates: {
              inPerMin: round(num(p.AvgTotalIncRate ?? p.AvgIncRate), 2), outPerMin: round(num(p.AvgTotalOutRate ?? p.AvgOutRate), 2),
              estTotalPerMin: round(num(p.EstTotalTransRate), 2),
              inPerTrip: { avg: round(num(p.AvgTripIncAmt)), median: round(num(p.MedianTripIncAmt)), latest: round(num(p.LatestTripIncAmt)) },
              outPerTrip: { avg: round(num(p.AvgTripOutAmt)), median: round(num(p.MedianTripOutAmt)), latest: round(num(p.LatestTripOutAmt)) },
            },
            roundTrip: { avg: p.AvgRndTrip ?? null, median: p.MedianRndTrip ?? null, latestS: round(num(p.LatestRndTrip)) },
            activeFuel: fuel(p.ActiveFuel),
            fuelOptions: asArray(p.FuelInfo).map(fuel).filter(Boolean),
            fuseTripped: !!p.PowerInfo?.FuseTriggered,
            location: loc(p),
          }));
        }
        if (include.includes("trucks")) {
          const [trucks, stations] = await Promise.all([frmGet(env, "getTruck"), frmGet(env, "getTruckStation")]);
          out.trucks = asArray(trucks).slice(0, limit).map((t) => ({
            name: t.Name,
            path: t.PathName,
            autopilot: !!t.Autopilot,
            autopilotStatus: t.AutoPilotStatus,
            followingPath: !!t.FollowingPath,
            hasFuel: !!t.HasFuel,
            fuel: inv(t.FuelInventory),
            cargo: inv(t.Inventory),
            location: loc(t),
          }));
          out.truckStations = asArray(stations).slice(0, limit);
        }
        return out;
      }),
  );

  server.registerTool(
    "station_throughput",
    {
      description:
        "Per train station and freight platform: load/unload mode, live status, cargo, transfer/inflow/outflow rates, plus which trains have this station on their " +
        "timetable, which are heading here now, and which are docked. FRM keeps no dwell history, so docking state is live only.",
      inputSchema: z.object({
        station: z.string().optional().describe("substring on station name"),
        limit: z.number().int().min(1).max(200).default(30),
      }),
    },
    async ({ station, limit }) =>
      guard(async () => {
        const [stationsRaw, trainsRaw] = await Promise.all([frmGet(env, "getTrainStation"), frmGet(env, "getTrains")]);
        const trains = asArray(trainsRaw);
        const stations = asArray(stationsRaw).filter((s) => !station || String(s.Name ?? "").toLowerCase().includes(station.toLowerCase()));
        return {
          stations: stations.length,
          rows: stations.slice(0, limit).map((s) => {
            const name = String(s.Name);
            const scheduled = trains.filter((t) => asArray(t.TimeTable).some((x: any) => (x.StationName ?? x.Name) === name));
            const inbound = trains.filter((t) => t.TrainStation === name);
            return {
              name,
              location: loc(s),
              transferRate: round(num(s.TransferRate), 2), inflowRate: round(num(s.InflowRate), 2), outflowRate: round(num(s.OutflowRate), 2),
              platforms: asArray(s.CargoInventory).map((p: any) => ({
                mode: p.LoadingMode, status: p.LoadingStatus, docking: p.DockingStatus,
                transferRate: round(num(p.TransferRate), 2), inflowRate: round(num(p.InflowRate), 2), outflowRate: round(num(p.OutflowRate), 2),
                inventory: inv(p.Inventory),
              })),
              trainsScheduled: scheduled.map((t) => t.Name ?? t.ID),
              trainsInbound: inbound.filter((t) => t.Docking === "TDS_None").map((t) => ({ name: t.Name ?? t.ID, status: t.Status, speed: Math.round(num(t.ForwardSpeed)), payloadPct: num(t.MaxPayloadMass) ? Math.round((num(t.PayloadMass) / num(t.MaxPayloadMass)) * 100) : null })),
              trainsDocked: inbound.filter((t) => t.Docking !== "TDS_None").map((t) => ({ name: t.Name ?? t.ID, docking: t.Docking, payloadPct: num(t.MaxPayloadMass) ? Math.round((num(t.PayloadMass) / num(t.MaxPayloadMass)) * 100) : null })),
            };
          }),
        };
      }),
  );

  server.registerTool(
    "belt_load",
    {
      description:
        "Conveyor belts by tier: count, cap (items/min), total length, dangling ends, and belts too slow for the machine they feed or drain. " +
        "A belt's ItemsPerMinute in FRM is just the tier cap; measured flow exists only where a Throughput Counter is built (getThroughputCounter). " +
        "Every counter is reported with its measured items/min, the cap of the belt it sits on, utilisation, and FRM's confidence in the average; " +
        "saturated means at or above saturated_pct of the cap with confidence of at least 50 %. Elsewhere saturation is inferred: a belt whose end sits in a machine's " +
        "bounding box is compared against that machine's max input/output rate (worst-case ingredient). " +
        "bbox is in map units (cm, the same numbers as every location in these tools).",
      inputSchema: z.object({
        bbox: z.object({ min_x: z.number(), min_y: z.number(), max_x: z.number(), max_y: z.number() }).optional(),
        tier: z.number().int().min(1).max(6).optional(),
        only_problems: z.boolean().default(false).describe("skip the per-tier summary and dangling list; just the too-slow belts and saturated counters"),
        saturated_pct: z.number().min(1).max(100).default(95).describe("a counter at or above this % of its belt's cap is saturated"),
        limit: z.number().int().min(1).max(300).default(50),
      }),
    },
    async ({ bbox, tier, only_problems, saturated_pct, limit }) =>
      guard(async () => {
        const [beltsRaw, factory, countersRaw] = await Promise.all([
          frmGet(env, "getBelts"), frmGet(env, "getFactory"), frmGet(env, "getThroughputCounter").catch(() => null),
        ]);
        const inB = (p: any) => !bbox || (num(p?.x) >= bbox.min_x && num(p?.x) <= bbox.max_x && num(p?.y) >= bbox.min_y && num(p?.y) <= bbox.max_y);
        const belts = asArray(beltsRaw).filter((b) => (!tier || beltTier(b) === tier) && (inB(b.location0) || inB(b.location1)));
        const machines = asArray(factory).filter((m) => m.BoundingBox);
        const counters = counterReport(asArray(countersRaw).filter((c) => inB(c.location)), belts, machines, saturated_pct);

        const tiers: Record<string, any> = {};
        const dangling: any[] = [];
        const tooSlow: any[] = [];
        for (const b of belts) {
          const t = beltTier(b), cap = num(b.ItemsPerMinute) || BELT_CAP[t] || 0;
          const s = (tiers[`Mk${t}`] ??= { tier: t, count: 0, capPerMin: cap, totalLengthM: 0, dangling: 0 });
          s.count++; s.totalLengthM += num(b.Length) / 100;
          if (b.Connected0 === false || b.Connected1 === false) {
            s.dangling++;
            if (dangling.length < limit) dangling.push({ id: b.ID, tier: t, freeEnd: b.Connected0 === false ? "start" : "end", location: loc(b) });
          }
          const p0 = pt(b.location0), p1 = pt(b.location1);
          for (const m of machines) {
            if (p1 && inBox(p1, m.BoundingBox, 120)) {
              const need = asArray(m.ingredients).map((i: any) => ({ item: i.Name, rate: num(i.MaxConsumed) })).sort((a, b) => b.rate - a.rate)[0];
              if (need && need.rate > cap) tooSlow.push({ belt: b.ID, tier: t, capPerMin: cap, role: "feeds", machine: m.Name, machineId: m.ID, recipe: m.Recipe, item: need.item, machineRatePerMin: round(need.rate), location: loc(m) });
            }
            if (p0 && inBox(p0, m.BoundingBox, 120)) {
              const out = asArray(m.production).map((o: any) => ({ item: o.Name, rate: num(o.MaxProd) })).sort((a, b) => b.rate - a.rate)[0];
              if (out && out.rate > cap) tooSlow.push({ belt: b.ID, tier: t, capPerMin: cap, role: "drains", machine: m.Name, machineId: m.ID, recipe: m.Recipe, item: out.item, machineRatePerMin: round(out.rate), location: loc(m) });
            }
          }
        }
        for (const s of Object.values(tiers)) s.totalLengthM = Math.round(s.totalLengthM);
        const sorted = tooSlow.sort((a, b) => b.machineRatePerMin - b.capPerMin - (a.machineRatePerMin - a.capPerMin));
        const base = {
          beltsConsidered: belts.length,
          tooSlow: { count: sorted.length, rows: sorted.slice(0, limit) },
          counters: only_problems
            ? { total: counters.length, saturated: counters.filter((c) => c.saturated).length, rows: counters.filter((c) => c.saturated).slice(0, limit) }
            : { total: counters.length, saturated: counters.filter((c) => c.saturated).length, rows: counters.slice(0, limit), note: countersRaw == null ? "getThroughputCounter unavailable (FRM predates it)" : counters.length ? "measured items/min from FRM's conveyor monitors; utilisation is against the belt's tier cap" : "no throughput counters built" },
        };
        return only_problems ? base : { ...base, tiers: Object.values(tiers).sort((a: any, b: any) => a.tier - b.tier), dangling: { count: belts.filter((b) => b.Connected0 === false || b.Connected1 === false).length, rows: dangling } };
      }),
  );

  server.registerTool(
    "pipe_load",
    {
      description:
        "Pipes by tier: count, flow cap (m³/min), total length, and every unconnected pipe end, classified by what it is touching. " +
        "A free end sitting inside a junction's, pump's, valve's, or machine's bounding box is reported as phantom: it snapped visually but never joined the fluid network " +
        "(the failure mode of mod-placed junction connectors; a bank fed through one starves with no other symptom). Free ends in open air are listed separately as open. " +
        "Run it after any pipe build, before trusting a flow indicator. bbox is in map units (cm).",
      inputSchema: z.object({
        bbox: z.object({ min_x: z.number(), min_y: z.number(), max_x: z.number(), max_y: z.number() }).optional(),
        only_problems: z.boolean().default(false).describe("skip the per-tier summary and open-end list; just the phantom connections"),
        limit: z.number().int().min(1).max(300).default(50),
      }),
    },
    async ({ bbox, only_problems, limit }) =>
      guard(async () => {
        const opt = (e: any) => frmGet(env, e).catch(() => []);
        const [pipes, junctions, pumps, factory, generators, extractors] = await Promise.all([
          frmGet(env, "getPipes"), opt("getPipeJunctions"), opt("getPump"), opt("getFactory"), opt("getGenerators"), opt("getExtractor"),
        ]);
        const r = pipeReport(pipes, { junctions: asArray(junctions), pumps: asArray(pumps), machines: [...asArray(factory), ...asArray(generators), ...asArray(extractors)] }, { bbox, limit });
        return only_problems ? { pipesConsidered: r.pipesConsidered, phantom: r.phantom } : r;
      }),
  );
}
