// Historical storage: pure logic for turning FRM snapshots into D1 rows.
// No I/O here; src/store.ts does the SQL and src/frm.ts does the fetching.

import { asArray, num, pt, type Pt } from "./frm.ts";

export const TICK_SECONDS = 300;
export const HOUR = 3600;
export const RAW_RETENTION_SECONDS = 7 * 24 * HOUR;
/** Cluster radius for sites and generator fields, in map units (cm). */
export const CLUSTER_RADIUS_CM = 200 * 100;
/** Hourly site/gen rows are grouped by this cell size of the cluster center (cm). */
export const CELL_CM = 100 * 100;
export const SEED_SITES = 11;
export const SEED_FIELDS = 5;
/** Consecutive gap rows closer than this are one outage. */
export const GAP_MERGE_SECONDS = 2 * TICK_SECONDS;

// ---------------------------------------------------------------- snapshot

/** Raw FRM payloads for one tick. `power` and `session` are required; the rest are best-effort. */
export interface Snapshot {
  t: number;
  power: unknown;
  session: unknown;
  cloud: unknown | null;
  sink: unknown | null;
  xsink: unknown | null;
  factory?: unknown | null;
  generators?: unknown | null;
  prodStats?: unknown | null;
  stations?: unknown | null;
  trains?: unknown | null;
  schematics?: unknown | null;
}

// ---------------------------------------------------------------- state (KV)

export interface OpenVisit { train: string; arrived_ts: number; cargo: number }

/** Carried between ticks in KV so the sampler needs no D1 read. */
export interface HistoryState {
  epoch: number;
  session: string;
  playtime: number;
  /** ts of the last good sample */
  ts: number;
  /** true when the previous tick was a good sample (rates may be computed against it) */
  lastGood: boolean;
  /** lookup tables have been given coordinates from a live tick */
  seeded: boolean;
  /** open train visits by station */
  visits: Record<string, OpenVisit>;
  sinkTotals: { resource: number | null; exploration: number | null };
}

export const initialState = (): HistoryState => ({
  epoch: 0, session: "", playtime: 0, ts: 0, lastGood: false, seeded: false, visits: {},
  sinkTotals: { resource: null, exploration: null },
});

// ---------------------------------------------------------------- epoch guard

export interface Stamp { session: string; playtime: number }

/**
 * A new epoch starts on a session-name change or a play-time regression (an older save
 * was loaded). Nothing is ever compared across an epoch boundary. The very first sample
 * is epoch 1.
 */
export function nextEpoch(prev: Stamp & { epoch: number } | null, cur: Stamp): { epoch: number; bumped: boolean } {
  if (!prev || prev.epoch === 0) return { epoch: 1, bumped: true };
  if (cur.session !== prev.session || cur.playtime < prev.playtime) return { epoch: prev.epoch + 1, bumped: true };
  return { epoch: prev.epoch, bumped: false };
}

// ---------------------------------------------------------------- clustering

export interface Cluster<T> { cx: number; cy: number; cz: number; n: number; members: T[] }

/**
 * Greedy spatial clustering, the method site_status uses: items sorted by x then y, each
 * joins the nearest existing cluster whose (running-mean) center is within radiusCm in the
 * XY plane, else starts a new one.
 */
export function cluster<T>(items: { p: Pt; item: T }[], radiusCm: number): Cluster<T>[] {
  const sorted = [...items].sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y);
  const out: Cluster<T>[] = [];
  for (const { p, item } of sorted) {
    let best: Cluster<T> | null = null, bd = Infinity;
    for (const c of out) {
      const d = Math.hypot(c.cx - p.x, c.cy - p.y);
      if (d <= radiusCm && d < bd) { best = c; bd = d; }
    }
    if (!best) { best = { cx: p.x, cy: p.y, cz: p.z, n: 0, members: [] }; out.push(best); }
    best.members.push(item); best.n++;
    best.cx += (p.x - best.cx) / best.n; best.cy += (p.y - best.cy) / best.n; best.cz += (p.z - best.cz) / best.n;
  }
  return out;
}

export interface Lookup { id: number; name: string; x: number | null; y: number | null; z: number | null }

/** Nearest lookup entry (XY distance) within radiusCm of the center, else null. */
export function resolveCenter(center: { x: number; y: number }, lookup: Lookup[], radiusCm = CLUSTER_RADIUS_CM): number | null {
  let best: number | null = null, bd = Infinity;
  for (const l of lookup) {
    if (l.x == null || l.y == null) continue;
    const d = Math.hypot(l.x - center.x, l.y - center.y);
    if (d <= radiusCm && d < bd) { best = l.id; bd = d; }
  }
  return best;
}

// ---------------------------------------------------------------- machines / sites

export type MachineState = "running" | "blocked" | "starved" | "unpowered" | "paused" | "unconfigured" | "idle";
export const MACHINE_STATES: MachineState[] = ["running", "blocked", "starved", "unpowered", "paused", "unconfigured", "idle"];

export const circuitMap = (power: unknown): Map<number, any> => {
  const m = new Map<number, any>();
  for (const c of asArray(power)) m.set(num(c.CircuitGroupID ?? c.CircuitID), c);
  return m;
};

/** blocked = output full, starved = an input is empty, unpowered = no capacity or fuse tripped. */
export function classifyMachine(m: any, circuits: Map<number, any>): MachineState {
  if (m.IsPaused) return "paused";
  if (m.IsConfigured === false) return "unconfigured";
  if (m.IsProducing) return "running";
  const c = circuits.get(num(m.PowerInfo?.CircuitGroupID));
  if (m.PowerInfo?.FuseTriggered || (c && num(c.PowerCapacity) === 0)) return "unpowered";
  if (asArray(m.OutputInventory).some((o: any) => num(o.MaxAmount) > 0 && num(o.Amount) >= num(o.MaxAmount))) return "blocked";
  const stock = new Map<string, number>(asArray(m.InputInventory).map((i: any) => [String(i.Name), num(i.Amount)]));
  if (asArray(m.ingredients).some((i: any) => (stock.get(String(i.Name)) ?? 0) === 0)) return "starved";
  return "idle";
}

export interface SiteRow {
  site_id: null; center_x: number; center_y: number; center_z: number;
  machines: number; running: number; blocked: number; starved: number; unpowered: number;
  paused: number; unconfigured: number; idle: number;
  mw_draw: number; mw_max: number; avg_productivity: number;
}

export function siteRows(factory: unknown, power: unknown, radiusCm = CLUSTER_RADIUS_CM): SiteRow[] {
  const circuits = circuitMap(power);
  const machines = asArray(factory).map((m) => ({ item: m, p: pt(m)! })).filter((x) => x.p);
  return cluster(machines, radiusCm).map((c) => {
    const st: Record<MachineState, number> = { running: 0, blocked: 0, starved: 0, unpowered: 0, paused: 0, unconfigured: 0, idle: 0 };
    let mw = 0, mwMax = 0, prod = 0;
    for (const m of c.members) {
      st[classifyMachine(m, circuits)]++;
      mw += num(m.PowerInfo?.PowerConsumed); mwMax += num(m.PowerInfo?.MaxPowerConsumed);
      prod += num(m.Productivity ?? m.Efficiency);
    }
    return {
      site_id: null, center_x: c.cx, center_y: c.cy, center_z: c.cz, machines: c.n, ...st,
      mw_draw: mw, mw_max: mwMax, avg_productivity: c.n ? prod / c.n : 0,
    };
  });
}

// ---------------------------------------------------------------- generators

export interface GenRow {
  fuel_type: string; field_id: number | null;
  center_x: number | null; center_y: number | null; center_z: number | null;
  total: number; fueled: number; dry: number; capacity_mw: number;
}

/** "Build_GeneratorCoal_C" -> "Coal", "Build_GeneratorIntegratedBiomass_C" -> "Biomass"; falls back to the display name. */
export function fuelTypeOf(g: any): string {
  const m = /Generator(?:Integrated)?([A-Za-z]+?)(?:_C)?$/.exec(String(g?.ClassName ?? ""));
  if (!m) return String(g?.Name ?? "Unknown");
  return m[1] === "GeoThermal" ? "Geothermal" : m[1];
}

/**
 * Current fuel on hand. Live FRM: `FuelAmount` is a number (fraction of the current unit for
 * liquid fuel); `FuelInventory` is the solid-fuel item list. `AvailableFuel` is the list of fuel
 * types the generator accepts, not stock, and must never be read as an amount.
 */
export function fuelAmount(g: any): number | null {
  if (typeof g?.FuelAmount === "number") return g.FuelAmount;
  const inv = g?.FuelInventory;
  if (typeof inv === "number") return inv;
  if (Array.isArray(inv)) return inv.reduce((n: number, i: any) => n + num(i?.Amount ?? i?.amount), 0);
  return null;
}

/** A generator is dry when it has no fuel and the game says it cannot start. Geothermal never needs fuel. */
export function isFueled(g: any): boolean {
  if (fuelTypeOf(g) === "Geothermal") return true;
  if (g?.CanStart === true) return true;
  const amt = fuelAmount(g);
  return amt != null ? amt > 0 : !!(g?.IsProducing ?? g?.IsFullSpeed);
}

/** Live FRM exposes ProductionCapacity (and BaseProd, the same number for fuel generators). */
export const genCapacityMw = (g: any): number =>
  num(g?.ProductionCapacity) || num(g?.PowerProductionPotential) || num(g?.BaseProd) + num(g?.DynamicProdCapacity);

/** One row per (fuel type, spatial cluster) with field_id null, plus one map-wide row per fuel type with field_id 0. */
export function genRows(generators: unknown, radiusCm = CLUSTER_RADIUS_CM): GenRow[] {
  const gens = asArray(generators).map((g) => ({ item: g, p: pt(g)! })).filter((x) => x.p);
  const out: GenRow[] = [];
  const mapWide = new Map<string, GenRow>();
  const tally = (row: GenRow, g: any) => {
    row.total++;
    if (isFueled(g)) row.fueled++; else row.dry++;
    row.capacity_mw += genCapacityMw(g);
  };
  for (const c of cluster(gens, radiusCm)) {
    const byFuel = new Map<string, GenRow>();
    for (const g of c.members) {
      const ft = fuelTypeOf(g);
      let row = byFuel.get(ft);
      if (!row) { row = { fuel_type: ft, field_id: null, center_x: c.cx, center_y: c.cy, center_z: c.cz, total: 0, fueled: 0, dry: 0, capacity_mw: 0 }; byFuel.set(ft, row); out.push(row); }
      tally(row, g);
      let mw = mapWide.get(ft);
      if (!mw) { mw = { fuel_type: ft, field_id: 0, center_x: null, center_y: null, center_z: null, total: 0, fueled: 0, dry: 0, capacity_mw: 0 }; mapWide.set(ft, mw); }
      tally(mw, g);
    }
  }
  return [...out, ...mapWide.values()];
}

// ---------------------------------------------------------------- depot / prod / sinks

export interface DepotRow { item: string; stock: number; capacity: number; is_full: number }

/** Depot capacity = stack × expansion multiplier ("Depot Expansion (400%)" research), inferred from the fullest items if research is unreadable. */
export function depotMultiplier(items: any[], schematics: unknown): number {
  const researched = asArray(schematics)
    .filter((r) => r.Purchased && /Depot Expansion \((\d+)%\)/.test(String(r.Name)))
    .map((r) => num(String(r.Name).match(/(\d+)%/)![1]) / 100);
  return researched.length
    ? Math.max(...researched)
    : Math.max(1, ...items.map((i) => (num(i.MaxAmount) ? Math.ceil(num(i.Amount) / num(i.MaxAmount)) : 1)));
}

export function depotRows(cloud: unknown, schematics: unknown): DepotRow[] {
  const items = asArray(cloud);
  const mult = depotMultiplier(items, schematics);
  return items.map((i) => {
    const stock = num(i.Amount), cap = num(i.MaxAmount) * mult;
    return { item: String(i.Name), stock, capacity: cap, is_full: cap > 0 && stock >= cap ? 1 : 0 };
  });
}

export interface ProdRow { item: string; produced_per_min: number; consumed_per_min: number; max_prod: number; max_cons: number }

export function prodRows(stats: unknown): ProdRow[] {
  return asArray(stats).map((s) => ({
    item: String(s.Name),
    produced_per_min: num(s.CurrentProd ?? s.CurrentProduction),
    consumed_per_min: num(s.CurrentConsumed ?? s.CurrentConsumption),
    max_prod: num(s.MaxProd ?? s.MaxProduction),
    max_cons: num(s.MaxConsumed ?? s.MaxConsumption),
  }));
}

export interface SinkRow { sink: "resource" | "exploration"; coupons: number; points_to_next: number; points_per_min: number | null }

/** points_per_min is against the previous good tick in the same epoch; null after a gap or an epoch change. */
export function sinkRows(
  sink: unknown, xsink: unknown, prevTotals: HistoryState["sinkTotals"], dtSeconds: number | null,
): { rows: SinkRow[]; totals: HistoryState["sinkTotals"] } {
  const rows: SinkRow[] = [];
  const totals: HistoryState["sinkTotals"] = { resource: null, exploration: null };
  const one = (kind: SinkRow["sink"], raw: unknown) => {
    const s: any = asArray(raw)[0];
    if (!s) return;
    const total = num(s.TotalPoints);
    totals[kind] = total;
    const prev = prevTotals[kind];
    const rate = prev != null && dtSeconds != null && dtSeconds > 0 ? ((total - prev) / dtSeconds) * 60 : null;
    rows.push({ sink: kind, coupons: num(s.NumCoupon), points_to_next: num(s.PointsToCoupon), points_per_min: rate });
  };
  one("resource", sink);
  one("exploration", xsink);
  return { rows, totals };
}

// ---------------------------------------------------------------- stations / train visits

export interface StationRow {
  station: string; platform: number; mode: "load" | "unload"; cargo: string | null;
  transfer_rate: number; docked_train: string | null; inbound: number;
}

/** Per-station view derived from getTrainStation + getTrains: which train is docked, and total platform inventory. */
export interface StationNow { station: string; docked: string | null; cargo: number }

const trainName = (t: any) => String(t.Name ?? t.ID ?? "");
const isDocked = (t: any) => t.Docking != null && t.Docking !== "TDS_None";

export function stationRows(stations: unknown, trains: unknown): { rows: StationRow[]; now: StationNow[] } {
  const ts = asArray(trains);
  const rows: StationRow[] = [];
  const now: StationNow[] = [];
  for (const s of asArray(stations)) {
    const name = String(s.Name ?? "");
    const here = ts.filter((t) => t.TrainStation === name);
    const docked = here.find(isDocked);
    const dockedName = docked ? trainName(docked) : null;
    const inbound = here.filter((t) => !isDocked(t)).length;
    let cargoTotal = 0;
    asArray(s.CargoInventory).forEach((p: any, i: number) => {
      const inv = asArray(p.Inventory).map((x: any) => ({ name: String(x.Name), amount: num(x.Amount ?? x.amount) }));
      const top = inv.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount)[0];
      cargoTotal += inv.reduce((n, x) => n + x.amount, 0);
      rows.push({
        station: name, platform: i,
        mode: /unload/i.test(String(p.LoadingMode ?? "")) ? "unload" : "load",
        cargo: top?.name ?? null,
        transfer_rate: num(p.TransferRate ?? s.TransferRate),
        docked_train: dockedName, inbound,
      });
    });
    now.push({ station: name, docked: dockedName, cargo: cargoTotal });
  }
  return { rows, now };
}

export interface VisitOpen { station: string; train: string; arrived_ts: number }
export interface VisitClose { station: string; train: string; arrived_ts: number; departed_ts: number; delta_cargo: number }

/**
 * docked_train non-null -> null closes the open visit for that station/train with departed_ts = now and
 * delta_cargo = platform inventory at arrival minus at departure. A train swap (A -> B) closes A and opens B.
 * The returned `visits` is the new open set for the state.
 */
export function stepVisits(open: Record<string, OpenVisit>, now: StationNow[], ts: number): { opens: VisitOpen[]; closes: VisitClose[]; visits: Record<string, OpenVisit> } {
  const opens: VisitOpen[] = [], closes: VisitClose[] = [];
  const visits: Record<string, OpenVisit> = { ...open };
  const seen = new Set<string>();
  for (const s of now) {
    seen.add(s.station);
    const cur = visits[s.station];
    if (cur && cur.train !== s.docked) {
      closes.push({ station: s.station, train: cur.train, arrived_ts: cur.arrived_ts, departed_ts: ts, delta_cargo: cur.cargo - s.cargo });
      delete visits[s.station];
    }
    if (s.docked && visits[s.station]?.train !== s.docked) {
      visits[s.station] = { train: s.docked, arrived_ts: ts, cargo: s.cargo };
      opens.push({ station: s.station, train: s.docked, arrived_ts: ts });
    }
  }
  // A station that vanished from FRM (dismantled): close its visit rather than leave it dangling.
  for (const [station, cur] of Object.entries(visits)) {
    if (!seen.has(station)) {
      closes.push({ station, train: cur.train, arrived_ts: cur.arrived_ts, departed_ts: ts, delta_cargo: 0 });
      delete visits[station];
    }
  }
  return { opens, closes, visits };
}

// ---------------------------------------------------------------- tick

export interface Key { ts: number; session: string; playtime: number; epoch: number }

export interface PowerRow {
  circuit_group: number; capacity_mw: number; production_mw: number; consumed_mw: number; max_consumed_mw: number;
  battery_pct: number | null; battery_in_mw: number | null; battery_out_mw: number | null; fuse_tripped: number;
}

export function powerRows(power: unknown): PowerRow[] {
  return asArray(power).map((c) => {
    const hasBattery = num(c.BatteryCapacity) > 0;
    return {
      circuit_group: num(c.CircuitGroupID ?? c.CircuitID),
      capacity_mw: num(c.PowerCapacity), production_mw: num(c.PowerProduction),
      consumed_mw: num(c.PowerConsumed), max_consumed_mw: num(c.PowerMaxConsumed),
      battery_pct: hasBattery ? num(c.BatteryPercent) : null,
      battery_in_mw: hasBattery ? num(c.BatteryInput) : null,
      battery_out_mw: hasBattery ? num(c.BatteryOutput) : null,
      fuse_tripped: c.FuseTriggered ? 1 : 0,
    };
  });
}

export interface Tick {
  key: Key;
  epochBumped: boolean;
  power: PowerRow[];
  site: SiteRow[];
  gen: GenRow[];
  depot: DepotRow[];
  prod: ProdRow[];
  station: StationRow[];
  sink: SinkRow[];
  visitOpens: VisitOpen[];
  visitCloses: VisitClose[];
  /** first live tick only: coordinates for lookup rows that still have none */
  seedSites: Pt[];
  seedFields: Pt[];
  state: HistoryState;
}

export function stampOf(session: unknown): Stamp | null {
  const s: any = asArray(session)[0];
  if (!s || s.SessionName == null) return null;
  return { session: String(s.SessionName), playtime: Math.floor(num(s.TotalPlayDuration)) };
}

/** Turn one snapshot into the rows for this tick and the state to carry to the next one. Pure. */
export function buildTick(snap: Snapshot, prev: HistoryState, ts = Math.floor(snap.t / 1000)): Tick {
  const stamp = stampOf(snap.session);
  if (!stamp) throw new Error("getSessionInfo has no SessionName; cannot attribute samples");
  const { epoch, bumped } = nextEpoch(prev.epoch ? prev : null, stamp);
  const key: Key = { ts, ...stamp, epoch };
  // Rates and open visits never cross an epoch boundary or a gap.
  const continuous = !bumped && prev.lastGood;
  const dt = continuous ? ts - prev.ts : null;

  const site = snap.factory != null ? siteRows(snap.factory, snap.power) : [];
  const gen = snap.generators != null ? genRows(snap.generators) : [];
  const { rows: station, now } = snap.stations != null ? stationRows(snap.stations, snap.trains) : { rows: [], now: [] };
  const { opens, closes, visits } = snap.stations != null
    ? stepVisits(continuous ? prev.visits : {}, now, ts)
    : { opens: [], closes: [], visits: continuous ? prev.visits : {} };
  const { rows: sink, totals } = sinkRows(snap.sink, snap.xsink, continuous ? prev.sinkTotals : { resource: null, exploration: null }, dt);

  const seed = !prev.seeded && site.length > 0;
  const seedSites = seed ? [...site].sort((a, b) => b.machines - a.machines).slice(0, SEED_SITES).map((s) => ({ x: s.center_x, y: s.center_y, z: s.center_z })) : [];
  const fieldClusters = new Map<string, { p: Pt; total: number }>();
  for (const g of gen) if (g.field_id === null) {
    const k = `${g.center_x},${g.center_y}`;
    const f = fieldClusters.get(k) ?? { p: { x: g.center_x!, y: g.center_y!, z: g.center_z! }, total: 0 };
    f.total += g.total; fieldClusters.set(k, f);
  }
  const seedFields = seed ? [...fieldClusters.values()].sort((a, b) => b.total - a.total).slice(0, SEED_FIELDS).map((f) => f.p) : [];

  return {
    key, epochBumped: bumped,
    power: powerRows(snap.power),
    site, gen,
    depot: snap.cloud != null ? depotRows(snap.cloud, snap.schematics) : [],
    prod: snap.prodStats != null ? prodRows(snap.prodStats) : [],
    station, sink,
    visitOpens: opens, visitCloses: closes,
    seedSites, seedFields,
    state: {
      epoch, session: stamp.session, playtime: stamp.playtime, ts, lastGood: true,
      seeded: prev.seeded || seed, visits, sinkTotals: totals,
    },
  };
}

/** State after a gap tick: epoch and last-known stamp stay, but nothing may be continued across it. */
export function gapState(prev: HistoryState): HistoryState {
  return { ...prev, lastGood: false, visits: {}, sinkTotals: { resource: null, exploration: null } };
}

// ---------------------------------------------------------------- read helpers

export type Res = "raw" | "hourly";

/** raw for windows of ≤ 7 days that lie inside raw retention, else hourly. */
export function pickRes(from: number, to: number, now: number, res?: string | null): Res {
  if (res === "raw" || res === "hourly") return res;
  return to - from <= RAW_RETENTION_SECONDS && from >= now - RAW_RETENTION_SECONDS - HOUR ? "raw" : "hourly";
}

export interface Gap { from: number; to: number }

/** Sorted gap timestamps -> intervals; adjacent ticks merge. */
export function coalesceGaps(ts: number[], maxSpacing = GAP_MERGE_SECONDS): Gap[] {
  const out: Gap[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && t - last.to <= maxSpacing) last.to = t;
    else out.push({ from: t, to: t });
  }
  return out;
}

export const bucketOf = (ts: number) => Math.floor(ts / HOUR) * HOUR;
export const cellOf = (v: number) => Math.trunc(v / CELL_CM);
