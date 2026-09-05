// Factory views: session, problems, production balance, item search, sites.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Env,
  frmGet,
  asArray,
  num,
  loc,
  pt,
  fmtPt,
  round,
} from "../../frm/client.ts";
import { cluster, classifyMachine, circuitMap, type MachineState } from "../../history/history.ts";

import { guard } from "../shared.ts";

export function registerFactory(server: McpServer, env: Env): void {
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
}
