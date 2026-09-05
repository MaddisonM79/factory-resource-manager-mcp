import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { z } from "zod";
import {
  type Env,
  READ_ENDPOINTS,
  WRITE_ENDPOINTS,
  frmGet,
  frmPost,
  asArray,
  matches,
  project,
  pack,
  num,
  loc,
  pt,
  fmtPt,
  inBox,
  round,
  takeSample,
  appendSample,
  windowOf,
  type TrendWindow,
  minutesBetween,
  iso,
  type Sample,
} from "./frm";
import { cluster, classifyMachine, circuitMap, type MachineState } from "./history";
import { api, querySeries } from "./api";
import { runTick, runRollup } from "./sampler";
import { thinSeries } from "./store";
import { pipeReport } from "./pipes";
import { dash } from "./dash";

type Props = { user: string };

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

async function guard<T>(fn: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const out = await fn();
    return text(typeof out === "string" ? out : pack(out));
  } catch (e: any) {
    return { ...text(`Error: ${e?.message ?? String(e)}`), isError: true };
  }
}

const inv = (items: unknown) => asArray(items).map((i: any) => ({ name: i.Name, amount: num(i.Amount ?? i.amount) }));

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

// ----------------------------------------------------------------------
// MCP server factory. Stateless: a fresh McpServer per request, no Durable
// Object. Tools close over env.
// ----------------------------------------------------------------------
function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "frm", version: "0.3.0" });

  // ------------------------------------------------------------------
  // 1. Generic escape hatch: any read endpoint, with filter/fields/limit.
  // ------------------------------------------------------------------
  server.registerTool(
    "frm_get",
    {
      description:
        "Call any Ficsit Remote Monitoring read endpoint. Use filter (substring across the item's JSON), " +
        "fields (comma-separated top-level keys to keep), and limit to keep responses small — getFactory/getBelts on a big base are enormous.",
      inputSchema: z.object({
        endpoint: z.enum(READ_ENDPOINTS),
        filter: z.string().optional().describe("case-insensitive substring; item kept if its JSON contains it"),
        fields: z.string().optional().describe("comma-separated keys to keep, e.g. 'Name,Recipe,Productivity,location'"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    },
    async ({ endpoint, filter, fields, limit, offset }) =>
      guard(async () => {
        const items = asArray(await frmGet(env, endpoint)).filter((i) => matches(i, filter));
        const f = fields?.split(",").map((s) => s.trim()).filter(Boolean);
        return {
          endpoint,
          total: items.length,
          returned: Math.min(limit, Math.max(0, items.length - offset)),
          items: items.slice(offset, offset + limit).map((i) => project(i, f)),
        };
      }),
  );

  // ------------------------------------------------------------------
  // 2. Curated views.
  // ------------------------------------------------------------------
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
    "factory_problems",
    {
      description:
        "Find production buildings that are idle, paused, unconfigured, or running below an efficiency threshold. " +
        "Groups by building type + recipe so a starved row shows up as one line, not forty.",
      inputSchema: z.object({
        max_efficiency: z.number().min(0).max(100).default(95).describe("flag buildings at or below this %"),
        building: z.string().optional().describe("substring on building name, e.g. 'Assembler'"),
        recipe: z.string().optional().describe("substring on recipe name"),
        limit: z.number().int().min(1).max(200).default(40),
      }),
    },
    async ({ max_efficiency, building, recipe, limit }) =>
      guard(async () => {
        const all = asArray(await frmGet(env, "getFactory"));
        const eff = (m: any) => num(m.Productivity ?? m.Efficiency);
        const bad = all.filter((m) => {
          if (building && !String(m.Name ?? "").toLowerCase().includes(building.toLowerCase())) return false;
          if (recipe && !String(m.Recipe ?? "").toLowerCase().includes(recipe.toLowerCase())) return false;
          const producing = m.IsProducing ?? true;
          const paused = m.IsPaused ?? false;
          const configured = m.IsConfigured ?? true;
          return !producing || paused || !configured || eff(m) <= max_efficiency;
        });

        const groups = new Map<string, any>();
        for (const m of bad) {
          const key = `${m.Name}|${m.Recipe ?? "(no recipe)"}`;
          const g = groups.get(key) ?? {
            building: m.Name,
            recipe: m.Recipe ?? null,
            count: 0,
            avgEfficiency: 0,
            idle: 0,
            paused: 0,
            unconfigured: 0,
            examples: [] as any[],
          };
          g.count++;
          g.avgEfficiency += eff(m);
          if (m.IsProducing === false) g.idle++;
          if (m.IsPaused) g.paused++;
          if (m.IsConfigured === false) g.unconfigured++;
          if (g.examples.length < 3) {
            g.examples.push({
              id: m.ID,
              efficiency: eff(m),
              location: loc(m),
              ingredients: asArray(m.ingredients ?? m.Ingredients).map((i: any) => ({
                name: i.Name,
                stock: i.Amount ?? i.amount,
                perMin: i.CurrentConsumed ?? i.ConsPerMin,
                maxPerMin: i.MaxConsumed,
              })),
              output: asArray(m.production ?? m.Production).map((o: any) => ({
                name: o.Name,
                stock: o.Amount ?? o.amount,
                perMin: o.CurrentProd,
                maxPerMin: o.MaxProd,
              })),
            });
          }
          groups.set(key, g);
        }
        const rows = [...groups.values()]
          .map((g) => ({ ...g, avgEfficiency: Math.round((g.avgEfficiency / g.count) * 10) / 10 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
        return { totalBuildings: all.length, flagged: bad.length, groups: rows };
      }),
  );

  server.registerTool(
    "production_balance",
    {
      description:
        "Item-level production vs consumption from getProdStats. Shows deficits (consuming more than producing) first. Filter by item name.",
      inputSchema: z.object({
        item: z.string().optional().describe("substring on item name"),
        only_deficit: z.boolean().default(false),
        limit: z.number().int().min(1).max(300).default(60),
      }),
    },
    async ({ item, only_deficit, limit }) =>
      guard(async () => {
        const stats = asArray(await frmGet(env, "getProdStats"));
        const rows = stats
          .filter((s) => !item || String(s.Name ?? "").toLowerCase().includes(item.toLowerCase()))
          .map((s) => {
            const prod = num(s.CurrentProd ?? s.CurrentProduction);
            const cons = num(s.CurrentConsumed ?? s.CurrentConsumption);
            return {
              item: s.Name,
              producedPerMin: prod,
              consumedPerMin: cons,
              netPerMin: Math.round((prod - cons) * 100) / 100,
              maxProdPerMin: num(s.MaxProd ?? s.MaxProduction),
              maxConsPerMin: num(s.MaxConsumed ?? s.MaxConsumption),
              prodPct: num(s.ProdPercent),
              consPct: num(s.ConsPercent),
            };
          })
          .filter((r) => !only_deficit || r.netPerMin < 0)
          .sort((a, b) => a.netPerMin - b.netPerMin)
          .slice(0, limit);
        return { total: stats.length, rows };
      }),
  );

  server.registerTool(
    "find_item",
    {
      description:
        "Where is an item? Searches every storage container (and optionally the world/cloud inventory) and returns containers holding it with amounts and locations.",
      inputSchema: z.object({
        item: z.string().describe("item name substring, e.g. 'Reinforced Iron Plate'"),
        include_world: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    async ({ item, include_world, limit }) =>
      guard(async () => {
        const needle = item.toLowerCase();
        const [storage, world] = await Promise.all([
          frmGet(env, "getStorageInv"),
          include_world ? frmGet(env, "getWorldInv") : Promise.resolve([]),
        ]);
        const hits: any[] = [];
        for (const c of asArray(storage)) {
          const found = asArray(c.Inventory ?? c.inventory).filter((s: any) =>
            String(s.Name ?? "").toLowerCase().includes(needle),
          );
          if (found.length) {
            hits.push({
              container: c.Name,
              id: c.ID,
              location: loc(c),
              items: found.map((s: any) => ({ name: s.Name, amount: num(s.Amount ?? s.amount), max: s.MaxAmount })),
            });
          }
        }
        const worldHits = asArray(world)
          .filter((s: any) => String(s.Name ?? "").toLowerCase().includes(needle))
          .map((s: any) => ({ name: s.Name, amount: num(s.Amount ?? s.amount) }));
        const total = hits.reduce((n, h) => n + h.items.reduce((m: number, i: any) => m + num(i.amount), 0), 0);
        return { query: item, containersWithItem: hits.length, totalInStorage: total, containers: hits.slice(0, limit), world: worldHits };
      }),
  );

  server.registerTool(
    "logistics_status",
    {
      description:
        "Trains, drones, trucks and their stations: where each vehicle is, what it's carrying, per-platform load/unload state, and anything derailed or stuck.",
      inputSchema: z.object({
        include: z.array(z.enum(["trains", "drones", "trucks"])).default(["trains", "drones"]),
        limit: z.number().int().min(1).max(200).default(40),
      }),
    },
    async ({ include, limit }) =>
      guard(async () => {
        const out: Record<string, unknown> = {};
        if (include.includes("trains")) {
          const [trains, stations] = await Promise.all([frmGet(env, "getTrains"), frmGet(env, "getTrainStation")]);
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
        }
        if (include.includes("drones")) {
          const [drones, ports] = await Promise.all([frmGet(env, "getDrone"), frmGet(env, "getDroneStation")]);
          out.drones = asArray(drones).slice(0, limit).map((d) => ({
            name: d.Name,
            status: d.CurrentFlyingMode ?? d.Status,
            home: d.HomeStation,
            destination: d.PairedStation ?? d.Destination,
            location: loc(d),
          }));
          out.droneStations = asArray(ports).slice(0, limit).map((p) => ({
            name: p.Name,
            paired: p.PairedStation,
            fuel: p.FuelInventory ?? p.Fuel,
            input: inv(p.InputInventory),
            output: inv(p.OutputInventory),
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
    "session_status",
    {
      description: "Quick health check: session info, players online, UObject count, and whether FRM is reachable at all.",
    },
    async () =>
      guard(async () => {
        const [session, players, uobj] = await Promise.all([
          frmGet(env, "getSessionInfo"),
          frmGet(env, "getPlayer"),
          frmGet(env, "getUObjectCount").catch(() => null),
        ]);
        return {
          session,
          players: asArray(players).map((p) => ({ name: p.PlayerName ?? p.Name, online: p.Online, location: loc(p), health: p.PlayerHP })),
          uobjects: uobj,
        };
      }),
  );


  // ------------------------------------------------------------------
  // 2b. Site / logistics / sink / depot / trend views.
  // ------------------------------------------------------------------
  server.registerTool(
    "site_status",
    {
      description:
        "One row per factory site: production buildings clustered spatially (default 200 m radius). Per site: machine counts by state " +
        "(running, blocked = output full, starved = an input is empty, unpowered = circuit has no capacity or fuse tripped, paused, unconfigured, idle), " +
        "MW draw, buildings and recipes present, circuit groups. Answers 'what's asleep' in one call.",
      inputSchema: z.object({
        radius_m: z.number().min(25).max(2000).default(200).describe("cluster radius in metres"),
        min_machines: z.number().int().min(1).default(1),
        building: z.string().optional().describe("substring on building name, e.g. 'Smelter'"),
        sort: z.enum(["problems", "machines", "mw"]).default("problems"),
        limit: z.number().int().min(1).max(200).default(30),
      }),
    },
    async ({ radius_m, min_machines, building, sort, limit }) =>
      guard(async () => {
        const [factory, power] = await Promise.all([frmGet(env, "getFactory"), frmGet(env, "getPower")]);
        const circuits = circuitMap(power);
        type State = MachineState;
        const classify = (m: any): State => classifyMachine(m, circuits);

        const machines = asArray(factory)
          .filter((m) => !building || String(m.Name ?? "").toLowerCase().includes(building.toLowerCase()))
          .map((m) => ({ item: m, p: pt(m)! }))
          .filter((x) => x.p);
        // Same clustering the history sampler uses (src/history.ts), so site rows line up with /api/series/site.
        const clusters = cluster(machines, radius_m * 100);

        const totals: Record<State, number> = { running: 0, blocked: 0, starved: 0, unpowered: 0, paused: 0, unconfigured: 0, idle: 0 };
        const rows = clusters
          .filter((c) => c.n >= min_machines)
          .map((c, i) => {
            const states: Record<State, number> = { running: 0, blocked: 0, starved: 0, unpowered: 0, paused: 0, unconfigured: 0, idle: 0 };
            const buildings: Record<string, number> = {};
            const recipes: Record<string, number> = {};
            const groups = new Set<number>();
            let mw = 0, mwMax = 0, prod = 0, fuse = false;
            for (const m of c.members) {
              const st = classify(m); states[st]++; totals[st]++;
              buildings[m.Name] = (buildings[m.Name] ?? 0) + 1;
              const rc = m.Recipe ?? "(no recipe)"; recipes[rc] = (recipes[rc] ?? 0) + 1;
              if (m.PowerInfo) { groups.add(num(m.PowerInfo.CircuitGroupID)); mw += num(m.PowerInfo.PowerConsumed); mwMax += num(m.PowerInfo.MaxPowerConsumed); fuse ||= !!m.PowerInfo.FuseTriggered; }
              prod += num(m.Productivity ?? m.Efficiency);
            }
            return {
              site: i + 1,
              center: fmtPt({ x: c.cx, y: c.cy, z: c.cz }),
              machines: c.n,
              problems: c.n - states.running,
              states,
              mwDraw: round(mw), mwMax: round(mwMax),
              avgProductivity: round(prod / c.n),
              circuitGroups: [...groups].sort((a, b) => a - b),
              fuseTripped: fuse,
              buildings,
              recipes: Object.entries(recipes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} (${v})`),
            };
          })
          .sort((a, b) => sort === "machines" ? b.machines - a.machines : sort === "mw" ? b.mwDraw - a.mwDraw : b.problems - a.problems || b.machines - a.machines);
        return { radiusM: radius_m, sites: rows.length, totalMachines: machines.length, totals, rows: rows.slice(0, limit) };
      }),
  );

  const BELT_CAP: Record<number, number> = { 1: 60, 2: 120, 3: 270, 4: 480, 5: 780, 6: 1200 };
  const beltTier = (b: any) => num((String(b.ClassName ?? "").match(/Mk(\d)/) ?? [])[1]);

  server.registerTool(
    "belt_load",
    {
      description:
        "Conveyor belts by tier: count, cap (items/min), total length, dangling ends, and belts too slow for the machine they feed or drain. " +
        "FRM does not expose live belt throughput (its ItemsPerMinute is just the tier cap), so saturation is inferred: a belt whose end sits in a machine's " +
        "bounding box is compared against that machine's max input/output rate (worst-case ingredient). " +
        "bbox is in map units (cm, the same numbers as every location in these tools).",
      inputSchema: z.object({
        bbox: z.object({ min_x: z.number(), min_y: z.number(), max_x: z.number(), max_y: z.number() }).optional(),
        tier: z.number().int().min(1).max(6).optional(),
        only_problems: z.boolean().default(false).describe("skip the per-tier summary and dangling list; just the too-slow belts"),
        limit: z.number().int().min(1).max(300).default(50),
      }),
    },
    async ({ bbox, tier, only_problems, limit }) =>
      guard(async () => {
        const [beltsRaw, factory] = await Promise.all([frmGet(env, "getBelts"), frmGet(env, "getFactory")]);
        const inB = (p: any) => !bbox || (num(p?.x) >= bbox.min_x && num(p?.x) <= bbox.max_x && num(p?.y) >= bbox.min_y && num(p?.y) <= bbox.max_y);
        const belts = asArray(beltsRaw).filter((b) => (!tier || beltTier(b) === tier) && (inB(b.location0) || inB(b.location1)));
        const machines = asArray(factory).filter((m) => m.BoundingBox);

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
        const base = { beltsConsidered: belts.length, tooSlow: { count: sorted.length, rows: sorted.slice(0, limit) } };
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

  const history = (w: TrendWindow, now: number) => ({
    samplesUsed: w.samples.length,
    spanMinutes: w.samples.length ? round(minutesBetween(w.samples[0].t, now)) : 0,
    oldestUsable: w.samples.length ? iso(w.samples[0].t) : null,
    truncatedBy: w.truncatedBy,
    truncatedAt: w.truncatedAt ? iso(w.truncatedAt) : null,
  });

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
    "trend",
    {
      description:
        "Historical series from D1 (the same data as GET /api/series/*): power per circuit group, a site's machine states (by lookup id, or 'all' for every cluster), " +
        "generator fields (field id, 'all', or omit for map-wide), depot stock per item, item production/consumption, a train station's platforms, or sink progress. " +
        "from/to are unix seconds; res defaults to raw 5-minute samples for windows of ≤ 7 days and hourly aggregates beyond. " +
        "One series per epoch when the window spans a session change or save reload; gaps list outages, which are never interpolated across.",
      inputSchema: z.object({
        series: z.enum(["power", "site", "gens", "depot", "prod", "station", "sinks"]),
        key: z.string().optional().describe("site id, field id, item name, station name, or circuit group; 'all' for every site/field cluster"),
        from: z.number().int().optional().describe("unix seconds; default 24 h before `to`"),
        to: z.number().int().optional().describe("unix seconds; default now"),
        res: z.enum(["raw", "hourly"]).optional(),
        max_points: z.number().int().min(10).max(5000).default(600).describe("thin evenly to at most this many points per series"),
      }),
    },
    async ({ series, key, from, to, res, max_points }) =>
      guard(async () => {
        const now = Math.floor(Date.now() / 1000);
        const t = to ?? now, f = from ?? t - 24 * 3600;
        if (f > t) throw new Error("from must be <= to");
        const out = await querySeries(env, { kind: series, key, from: f, to: t, res }, now);
        // Per series key (circuit group, site, field, item, platform, sink): thinning the flat list drops whole keys.
        const thin = (s: Parameters<typeof thinSeries>[1]) => thinSeries(series, s, max_points);
        return Array.isArray(out) ? out.map(thin) : thin(out);
      }),
  );

  // ------------------------------------------------------------------
  // 3. Writes — gated by FRM_ALLOW_WRITE.
  // ------------------------------------------------------------------
  server.registerTool(
    "set_enabled",
    {
      description:
        "Enable or disable buildings by ID (constructors, assemblers, manufacturers, generators, power switches). Requires FRM_ALLOW_WRITE=true.",
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).describe("building IDs from getFactory/getGenerators/getSwitches"),
        enabled: z.boolean(),
      }),
    },
    async ({ ids, enabled }) =>
      guard(() => frmPost(env, "setEnabled", ids.length === 1 ? { ID: ids[0], status: enabled } : ids.map((ID) => ({ ID, status: enabled })))),
  );

  server.registerTool(
    "frm_write",
    {
      description: "Raw POST to any FRM write endpoint with a JSON body. Check docs.ficsit.app for the body shape. Requires FRM_ALLOW_WRITE=true.",
      inputSchema: z.object({
        endpoint: z.enum(WRITE_ENDPOINTS),
        body: z.unknown().describe("JSON body"),
      }),
    },
    async ({ endpoint, body }) => guard(() => frmPost(env, endpoint, body)),
  );

  return server;
}

// ----------------------------------------------------------------------
// Minimal single-user OAuth approval flow (claude.ai requires OAuth for
// remote connectors). One passphrase, no user database.
// ----------------------------------------------------------------------
const app = new Hono<{ Bindings: Env }>();

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>frm-mcp</title>
<style>body{font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 1rem;color:#eee;background:#111}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem;border-radius:6px;border:1px solid #444;background:#1b1b1b;color:#eee}
button{background:#f60;border:0;color:#000;font-weight:600;cursor:pointer}</style></head><body>${body}</body></html>`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

app.get("/", (c) => c.text("frm-mcp: MCP endpoint at /mcp (Streamable HTTP)"));

app.get("/authorize", async (c) => {
  const oauth = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const state = btoa(JSON.stringify(oauth));
  return c.html(
    page(`<h2>frm-mcp</h2><p>Authorize <b>${esc(oauth.clientId)}</b> to read your factory?</p>
<form method="post" action="/authorize">
<input type="hidden" name="state" value="${esc(state)}">
<input type="password" name="passphrase" placeholder="passphrase" autofocus>
<button type="submit">Approve</button></form>`),
  );
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const passphrase = String(form.get("passphrase") ?? "");
  const state = String(form.get("state") ?? "");
  if (!state) return c.text("missing state", 400);

  const enc = new TextEncoder();
  const a = enc.encode(passphrase);
  const b = enc.encode(c.env.ADMIN_PASSPHRASE);
  const ok = a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  if (!ok) return c.html(page("<h2>Nope.</h2><p><a href='javascript:history.back()'>Try again</a></p>"), 401);

  const oauth = JSON.parse(atob(state));
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth,
    userId: "owner",
    metadata: { label: "frm-mcp" },
    scope: oauth.scope,
    props: { user: "owner" } satisfies Props,
  });
  return Response.redirect(redirectTo, 302);
});

// ----------------------------------------------------------------------
// Worker entry. OAuthProvider fronts everything: /mcp requires a bearer
// token it issued; /authorize, /token, /register, / fall through to Hono.
// ----------------------------------------------------------------------
const mcp = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const handler = createMcpHandler(() => buildServer(env), {
      route: "/mcp",
      allowedHostnames: [...env.MCP_HOSTS.split(",").map((h) => h.trim()).filter(Boolean), "localhost", "127.0.0.1"],
      authContext: { props: ((ctx as any).props as Props | undefined) ?? {} },
      onerror: (e) => console.error("mcp:", e),
    });
    return handler(request, env, ctx);
  },
};

// /api/* shares the bearer check with /mcp: the provider validates the token before either handler runs.
const historyApi = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => api.fetch(request, env, ctx),
};

const provider = new OAuthProvider({
  apiHandlers: { "/mcp": mcp, "/api/": historyApi },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  // The dashboard host is a separate app: Hanko session cookie, static assets, the same read API.
  // Every other host (the MCP host, and the old one until it is removed) goes through the OAuth provider.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    new URL(request.url).hostname === env.DASH_HOST ? dash.fetch(request, env, ctx) : provider.fetch(request, env, ctx),
  // */5: sample into the KV ring and D1 (one batch). Daily: purge expired OAuth data, then roll up history.
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      (async () => {
        if (event.cron.startsWith("*/5")) {
          await runTick(env);
        } else {
          const r = await provider.purgeExpiredData(env);
          console.log("oauth purge:", JSON.stringify(r));
          const { cutoff } = await runRollup(env);
          console.log("history rollup: raw samples before", new Date(cutoff * 1000).toISOString(), "rolled to hourly");
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
