// D1 access for the history tables. One batch per sampler tick, one batch per rollup,
// plain SELECTs for the read API. SQL only; the shaping lives in src/history.ts.

import {
  type Tick, type HistoryState, type Key, type Lookup, type Res, type Gap,
  RAW_RETENTION_SECONDS, CLUSTER_RADIUS_CM, bucketOf, coalesceGaps, resolveCenter,
} from "./history.ts";

type Row = Record<string, unknown>;

/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 100;
const KEY_COLS = ["ts", "session", "playtime", "epoch"] as const;

const RAW_TABLES = ["power_samples", "site_samples", "gen_samples", "depot_samples", "prod_samples", "station_samples", "sink_samples", "drone_samples", "counter_samples"] as const;

// ---------------------------------------------------------------- writes

/** Multi-row INSERTs, chunked to stay under the parameter limit. */
export function insertStatements(db: D1Database, table: string, key: Key, rows: object[]): D1PreparedStatement[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const all = [...KEY_COLS, ...cols];
  const per = Math.max(1, Math.floor(MAX_PARAMS / all.length));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const sql = `INSERT INTO ${table} (${all.join(", ")}) VALUES ${chunk.map(() => `(${all.map(() => "?").join(", ")})`).join(", ")}`;
    const params = chunk.flatMap((r) => [key.ts, key.session, key.playtime, key.epoch, ...cols.map((c) => (r as Row)[c] ?? null)]);
    out.push(db.prepare(sql).bind(...params));
  }
  return out;
}

/** Everything for one good tick, as a single D1 batch (one round-trip). */
export async function writeTick(db: D1Database, t: Tick): Promise<void> {
  const k = t.key;
  const stmts: D1PreparedStatement[] = [
    ...insertStatements(db, "power_samples", k, t.power),
    ...insertStatements(db, "site_samples", k, t.site),
    ...insertStatements(db, "gen_samples", k, t.gen),
    ...insertStatements(db, "depot_samples", k, t.depot),
    ...insertStatements(db, "prod_samples", k, t.prod),
    ...insertStatements(db, "station_samples", k, t.station),
    ...insertStatements(db, "sink_samples", k, t.sink),
    ...insertStatements(db, "drone_samples", k, t.drone),
    ...insertStatements(db, "counter_samples", k, t.counter),
    ...insertStatements(db, "train_visits", k, t.visitOpens.map((v) => ({ ...v, departed_ts: null, delta_cargo: null }))),
    ...t.visitCloses.map((v) =>
      db.prepare("UPDATE train_visits SET departed_ts = ?, delta_cargo = ? WHERE station = ? AND train = ? AND arrived_ts = ? AND departed_ts IS NULL")
        .bind(v.departed_ts, v.delta_cargo, v.station, v.train, v.arrived_ts)),
    ...t.seedSites.map((p, i) => db.prepare("UPDATE sites SET x = ?, y = ?, z = ? WHERE id = ? AND x IS NULL").bind(p.x, p.y, p.z, i + 1)),
    ...t.seedFields.map((p, i) => db.prepare("UPDATE fields SET x = ?, y = ?, z = ? WHERE id = ? AND x IS NULL").bind(p.x, p.y, p.z, i + 1)),
  ];
  if (stmts.length) await db.batch(stmts);
}

/** The only row written on a tick where the origin was unreachable. */
export async function writeGap(db: D1Database, state: HistoryState, ts: number, reason: string): Promise<void> {
  await db.prepare("INSERT INTO gap_samples (ts, session, playtime, epoch, reason) VALUES (?, ?, ?, ?, ?)")
    .bind(ts, state.session, state.playtime, state.epoch, reason.slice(0, 200)).run();
}

// ---------------------------------------------------------------- rollup

const BUCKET = "(ts / 3600) * 3600";
const GAPS = "(SELECT COUNT(*) FROM gap_samples g WHERE g.epoch = s.epoch AND g.ts / 3600 = s.ts / 3600)";
const HEAD = `session, epoch, ${BUCKET}, COUNT(*), ${GAPS}, MAX(playtime)`;
const HEAD_COLS = "session, epoch, bucket_ts, sample_count, gap_count, playtime";

const ROLLUPS: { table: string; hourly: string; cols: string; select: string; group: string }[] = [
  {
    table: "power_samples", hourly: "hourly_power",
    cols: "circuit_group, capacity_mw, production_mw, consumed_mw, max_consumed_mw, battery_pct, battery_in_mw, battery_out_mw, fuse_tripped",
    select: "circuit_group, AVG(capacity_mw), AVG(production_mw), AVG(consumed_mw), AVG(max_consumed_mw), AVG(battery_pct), AVG(battery_in_mw), AVG(battery_out_mw), AVG(fuse_tripped)",
    group: "circuit_group",
  },
  {
    table: "site_samples", hourly: "hourly_site",
    cols: "cell_x, cell_y, site_id, center_x, center_y, center_z, machines, running, running_min, running_max, blocked, blocked_min, blocked_max, starved, starved_min, starved_max, unpowered, paused, unconfigured, idle, mw_draw, mw_max, avg_productivity",
    select: "CAST(center_x / 10000 AS INTEGER), CAST(center_y / 10000 AS INTEGER), MAX(site_id), AVG(center_x), AVG(center_y), AVG(center_z), AVG(machines), AVG(running), MIN(running), MAX(running), AVG(blocked), MIN(blocked), MAX(blocked), AVG(starved), MIN(starved), MAX(starved), AVG(unpowered), AVG(paused), AVG(unconfigured), AVG(idle), AVG(mw_draw), AVG(mw_max), AVG(avg_productivity)",
    group: "CAST(center_x / 10000 AS INTEGER), CAST(center_y / 10000 AS INTEGER)",
  },
  {
    // field_id: 0 = map-wide, -1 = spatial cluster (resolved on read by center). NULL would defeat the UNIQUE key.
    table: "gen_samples", hourly: "hourly_gen",
    cols: "fuel_type, field_id, cell_x, cell_y, center_x, center_y, center_z, total, fueled, dry, dry_min, dry_max, capacity_mw, load_pct, waste, waste_max",
    select: "fuel_type, COALESCE(field_id, -1), COALESCE(CAST(center_x / 10000 AS INTEGER), 0), COALESCE(CAST(center_y / 10000 AS INTEGER), 0), AVG(center_x), AVG(center_y), AVG(center_z), AVG(total), AVG(fueled), AVG(dry), MIN(dry), MAX(dry), AVG(capacity_mw), AVG(load_pct), AVG(waste), MAX(waste)",
    group: "fuel_type, COALESCE(field_id, -1), COALESCE(CAST(center_x / 10000 AS INTEGER), 0), COALESCE(CAST(center_y / 10000 AS INTEGER), 0)",
  },
  {
    table: "depot_samples", hourly: "hourly_depot",
    cols: "item, stock, stock_min, stock_max, capacity, is_full",
    select: "item, AVG(stock), MIN(stock), MAX(stock), AVG(capacity), AVG(is_full)",
    group: "item",
  },
  {
    table: "prod_samples", hourly: "hourly_prod",
    cols: "item, produced_per_min, consumed_per_min, max_prod, max_cons",
    select: "item, AVG(produced_per_min), AVG(consumed_per_min), AVG(max_prod), AVG(max_cons)",
    group: "item",
  },
  {
    table: "station_samples", hourly: "hourly_station",
    cols: "station, platform, mode, transfer_rate, docked, inbound",
    select: "station, platform, MAX(mode), AVG(transfer_rate), AVG(CASE WHEN docked_train IS NULL THEN 0 ELSE 1 END), AVG(inbound)",
    group: "station, platform",
  },
  {
    table: "sink_samples", hourly: "hourly_sink",
    cols: "sink, coupons, coupons_max, points_to_next, points_per_min",
    select: "sink, AVG(coupons), MAX(coupons), AVG(points_to_next), AVG(points_per_min)",
    group: "sink",
  },
  {
    table: "drone_samples", hourly: "hourly_drone",
    cols: "station, paired, status, in_per_min, out_per_min, est_per_min, round_trip_s, trip_in, trip_out, fuel, fuel_min, input_stock, output_stock",
    select: "station, MAX(paired), MAX(status), AVG(in_per_min), AVG(out_per_min), AVG(est_per_min), AVG(round_trip_s), AVG(trip_in), AVG(trip_out), AVG(fuel), MIN(fuel), AVG(input_stock), AVG(output_stock)",
    group: "station",
  },
  {
    table: "counter_samples", hourly: "hourly_counter",
    cols: "counter_id, name, belt, cap_per_min, items_per_min, items_min, items_max, confidence",
    select: "counter_id, MAX(name), MAX(belt), AVG(cap_per_min), AVG(items_per_min), MIN(items_per_min), MAX(items_per_min), AVG(confidence)",
    group: "counter_id",
  },
];

/** Raw samples older than the retention cutoff (aligned to an hour) roll into hourly rows, then are deleted. */
export function rollupCutoff(now: number): number {
  return bucketOf(now - RAW_RETENTION_SECONDS);
}

/**
 * Idempotent: hourly rows are keyed by (session, epoch, bucket_ts, dimension) and written with
 * INSERT OR REPLACE, so re-running over the same raw rows rewrites identical rows, and once the
 * raw rows are gone there is nothing left to roll. Gap rows are counted into gap_count and kept.
 */
export async function rollup(db: D1Database, now: number, deleteRaw = true): Promise<{ cutoff: number }> {
  const cutoff = rollupCutoff(now);
  const stmts: D1PreparedStatement[] = [];
  for (const r of ROLLUPS) {
    stmts.push(db.prepare(
      `INSERT OR REPLACE INTO ${r.hourly} (${HEAD_COLS}, ${r.cols}) ` +
      `SELECT ${HEAD}, ${r.select} FROM ${r.table} s WHERE ts < ? GROUP BY session, epoch, ts / 3600, ${r.group}`,
    ).bind(cutoff));
  }
  if (deleteRaw) for (const t of RAW_TABLES) stmts.push(db.prepare(`DELETE FROM ${t} WHERE ts < ?`).bind(cutoff));
  await db.batch(stmts);
  return { cutoff };
}

// ---------------------------------------------------------------- reads

export interface Series {
  epoch: number;
  session: string;
  res: Res;
  points: Row[];
  gaps: Gap[];
}

export type SeriesKind = "power" | "site" | "gens" | "depot" | "prod" | "station" | "sinks" | "drone" | "counter";

export interface SeriesQuery { kind: SeriesKind; from: number; to: number; res: Res; key?: string | null }

async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

const radiusWhere = (cx: string, cy: string) => `AND ((${cx} - ?) * (${cx} - ?) + (${cy} - ?) * (${cy} - ?)) <= ?`;
const radiusParams = (c: { x: number; y: number }) => [c.x, c.x, c.y, c.y, CLUSTER_RADIUS_CM * CLUSTER_RADIUS_CM];

function sql(res: Res, raw: string, hourly: string, rawCols: string, hourlyCols: string, where: string, order: string): string {
  return res === "raw"
    ? `SELECT ts, epoch, session, ${rawCols} FROM ${raw} WHERE ts BETWEEN ? AND ? ${where} ORDER BY ts, ${order}`
    : `SELECT bucket_ts AS ts, epoch, session, sample_count, gap_count, ${hourlyCols} FROM ${hourly} WHERE bucket_ts BETWEEN ? AND ? ${where} ORDER BY bucket_ts, ${order}`;
}

export async function listLookup(db: D1Database, table: "sites" | "fields"): Promise<Lookup[]> {
  return all<Lookup>(db, `SELECT id, name, x, y, z FROM ${table} ORDER BY id`);
}

export async function updateLookup(
  db: D1Database, table: "sites" | "fields", id: number, patch: { name?: string; x?: number; y?: number; z?: number },
): Promise<Lookup | null> {
  const sets: string[] = [], params: unknown[] = [];
  for (const k of ["name", "x", "y", "z"] as const) if (patch[k] !== undefined) { sets.push(`${k} = ?`); params.push(patch[k]); }
  if (sets.length) await db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();
  return (await db.prepare(`SELECT id, name, x, y, z FROM ${table} WHERE id = ?`).bind(id).first<Lookup>()) ?? null;
}

/** Hourly rows for the same site/field can straddle a cell boundary; merge them weighted by sample_count. */
export function mergeHourly(rows: Row[], keyOf: (r: Row) => string): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = out.get(k);
    if (!cur) { out.set(k, { ...r }); continue; }
    const n0 = Number(cur.sample_count ?? 1), n1 = Number(r.sample_count ?? 1);
    for (const c of Object.keys(r)) {
      const a = cur[c], b = r[c];
      if (typeof a !== "number" || typeof b !== "number") continue;
      if (c === "sample_count") cur[c] = a + b;
      else if (c === "gap_count") cur[c] = Math.max(a, b);
      else if (c.endsWith("_min")) cur[c] = Math.min(a, b);
      else if (c.endsWith("_max")) cur[c] = Math.max(a, b);
      else if (c !== "ts" && c !== "epoch" && !c.startsWith("cell_")) cur[c] = (a * n0 + b * n1) / (n0 + n1);
    }
  }
  return [...out.values()];
}

/** Rows -> one Series per epoch (gaps attached by epoch). */
export function toSeries(rows: Row[], gapRows: { ts: number; epoch: number }[], res: Res): Series[] {
  const byEpoch = new Map<number, Series>();
  for (const r of rows) {
    const { epoch, session, ...point } = r;
    const e = Number(epoch);
    let s = byEpoch.get(e);
    if (!s) { s = { epoch: e, session: String(session ?? ""), res, points: [], gaps: [] }; byEpoch.set(e, s); }
    s.points.push(point);
  }
  for (const g of gapRows) {
    const s = byEpoch.get(Number(g.epoch));
    if (s) s.gaps.push({ from: g.ts, to: g.ts });
  }
  for (const s of byEpoch.values()) s.gaps = coalesceGaps(s.gaps.map((g) => g.from));
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

export class NotFound extends Error {}

/** Columns that identify one series inside a kind; thinning and charting group by these. */
export const SERIES_KEY_COLS: Record<SeriesKind, string[]> = {
  power: ["circuit_group"],
  site: ["site_id"],
  gens: ["fuel_type", "field_id"],
  depot: ["item"],
  prod: ["item"],
  station: ["station", "platform"],
  sinks: ["sink"],
  drone: ["station"],
  counter: ["counter_id"],
};

export const seriesKeyOf = (kind: SeriesKind, r: Row): string => SERIES_KEY_COLS[kind].map((c) => String(r[c] ?? "")).join("|");

/**
 * Thin to at most `max` points per series key, evenly, keeping the first point of each key.
 * Thinning the flat row list would drop whole keys (a 20-point pull of 3 circuit groups kept 2), so group first.
 */
export function thinSeries(kind: SeriesKind, s: Series, max: number): Series & { thinned_from?: number } {
  const groups = new Map<string, Row[]>();
  for (const p of s.points) { const k = seriesKeyOf(kind, p); groups.set(k, [...(groups.get(k) ?? []), p]); }
  if (![...groups.values()].some((g) => g.length > max)) return s;
  const kept: Row[] = [];
  for (const g of groups.values()) {
    if (g.length <= max) { kept.push(...g); continue; }
    const step = g.length / max;
    for (let i = 0; i < max; i++) kept.push(g[Math.floor(i * step)]);
  }
  kept.sort((a, b) => Number(a.ts) - Number(b.ts));
  return { ...s, thinned_from: s.points.length, points: kept };
}

export interface Latest {
  /** ts of the newest good tick, or null when the tables are empty */
  ts: number | null;
  epoch: number | null;
  session: string | null;
  playtime: number | null;
  /** newest gap row, if it is newer than the newest good tick */
  gap: { ts: number; reason: string } | null;
  power: Row[];
  sites: Row[];
  gens: Row[];
  depot: Row[];
  prod: Row[];
  stations: Row[];
  sinks: Row[];
  drones: Row[];
  counters: Row[];
}

/** Every table's rows for the newest good tick, with sites and generator fields resolved to lookup names. */
export async function readLatest(db: D1Database): Promise<Latest> {
  const head = await db.prepare("SELECT ts, epoch, session, playtime FROM power_samples ORDER BY ts DESC LIMIT 1").first<{ ts: number; epoch: number; session: string; playtime: number }>();
  const gapRow = await db.prepare("SELECT ts, reason FROM gap_samples ORDER BY ts DESC LIMIT 1").first<{ ts: number; reason: string }>();
  const gap = gapRow && (!head || gapRow.ts > head.ts) ? gapRow : null;
  if (!head) return { ts: null, epoch: null, session: null, playtime: null, gap, power: [], sites: [], gens: [], depot: [], prod: [], stations: [], sinks: [], drones: [], counters: [] };
  const ts = head.ts;
  const at = (sql: string) => all(db, sql, ts);
  const [siteLookup, fieldLookup, power, sites, gens, depot, prod, stations, sinks, drones, counters] = await Promise.all([
    listLookup(db, "sites"), listLookup(db, "fields"),
    at("SELECT circuit_group, capacity_mw, production_mw, consumed_mw, max_consumed_mw, battery_pct, battery_in_mw, battery_out_mw, fuse_tripped FROM power_samples WHERE ts = ? ORDER BY circuit_group"),
    at("SELECT site_id, center_x, center_y, center_z, machines, running, blocked, starved, unpowered, paused, unconfigured, idle, mw_draw, mw_max, avg_productivity FROM site_samples WHERE ts = ? ORDER BY machines DESC"),
    at("SELECT fuel_type, field_id, center_x, center_y, center_z, total, fueled, dry, capacity_mw, load_pct, waste FROM gen_samples WHERE ts = ? ORDER BY fuel_type, field_id"),
    at("SELECT item, stock, capacity, is_full FROM depot_samples WHERE ts = ? ORDER BY item"),
    at("SELECT item, produced_per_min, consumed_per_min, max_prod, max_cons FROM prod_samples WHERE ts = ? ORDER BY item"),
    at("SELECT station, platform, mode, cargo, transfer_rate, docked_train, inbound FROM station_samples WHERE ts = ? ORDER BY station, platform"),
    at("SELECT sink, coupons, points_to_next, points_per_min FROM sink_samples WHERE ts = ? ORDER BY sink"),
    at("SELECT station, paired, status, in_per_min, out_per_min, est_per_min, round_trip_s, trip_in, trip_out, fuel, input_stock, output_stock FROM drone_samples WHERE ts = ? ORDER BY station"),
    at("SELECT counter_id, name, belt, cap_per_min, items_per_min, confidence FROM counter_samples WHERE ts = ? ORDER BY name, counter_id"),
  ]);
  const nameOf = (lookup: Lookup[], id: unknown) => lookup.find((l) => l.id === Number(id))?.name ?? null;
  return {
    ts, epoch: head.epoch, session: head.session, playtime: head.playtime, gap,
    power,
    sites: sites.map((r) => {
      const site_id = r.site_id ?? resolveCenter({ x: Number(r.center_x), y: Number(r.center_y) }, siteLookup);
      return { ...r, site_id, name: nameOf(siteLookup, site_id) };
    }),
    gens: gens.map((r) => {
      const field_id = r.field_id == null ? resolveCenter({ x: Number(r.center_x), y: Number(r.center_y) }, fieldLookup) : Number(r.field_id);
      return { ...r, field_id, name: field_id === 0 ? "map-wide" : nameOf(fieldLookup, field_id) };
    }),
    depot, prod, stations, sinks, drones, counters,
  };
}

export async function readSeries(db: D1Database, q: SeriesQuery): Promise<Series[]> {
  const { from, to, res } = q;
  const gapsP = all<{ ts: number; epoch: number }>(db, "SELECT ts, epoch FROM gap_samples WHERE ts BETWEEN ? AND ? ORDER BY ts", from, to);
  let rows: Row[];
  switch (q.kind) {
    case "power":
      rows = await all(db, sql(res, "power_samples", "hourly_power",
        "circuit_group, capacity_mw, production_mw, consumed_mw, max_consumed_mw, battery_pct, battery_in_mw, battery_out_mw, fuse_tripped",
        "circuit_group, capacity_mw, production_mw, consumed_mw, max_consumed_mw, battery_pct, battery_in_mw, battery_out_mw, fuse_tripped",
        q.key ? "AND circuit_group = ?" : "", "circuit_group"), from, to, ...(q.key ? [Number(q.key)] : []));
      break;
    case "site": {
      const lookup = await listLookup(db, "sites");
      const rawCols = "center_x, center_y, center_z, machines, running, blocked, starved, unpowered, paused, unconfigured, idle, mw_draw, mw_max, avg_productivity";
      const hourlyCols = "center_x, center_y, center_z, machines, running, running_min, running_max, blocked, blocked_min, blocked_max, starved, starved_min, starved_max, unpowered, paused, unconfigured, idle, mw_draw, mw_max, avg_productivity";
      const resolve = (r: Row) => ({ ...r, site_id: resolveCenter({ x: Number(r.center_x), y: Number(r.center_y) }, lookup) });
      if (q.key === "all") {
        // Every cluster; unresolved ones carry site_id null and their raw center.
        const raw = (await all(db, sql(res, "site_samples", "hourly_site", rawCols, hourlyCols, "", "center_x, center_y"), from, to)).map(resolve);
        rows = res === "hourly" ? mergeHourly(raw, (r) => `${r.epoch}:${r.ts}:${r.site_id ?? `${r.cell_x}:${r.cell_y}`}`) : raw;
        break;
      }
      const site = lookup.find((l) => l.id === Number(q.key));
      if (!site) throw new NotFound(`unknown site ${q.key}`);
      if (site.x == null || site.y == null) { rows = []; break; }
      const c = { x: site.x, y: site.y };
      const raw = await all(db, sql(res, "site_samples", "hourly_site", rawCols, hourlyCols, radiusWhere("center_x", "center_y"), "center_x"), from, to, ...radiusParams(c));
      const mine = raw.map(resolve).filter((r) => r.site_id === site.id);
      rows = res === "hourly" ? mergeHourly(mine, (r) => `${r.epoch}:${r.ts}`) : mine;
      break;
    }
    case "gens": {
      const rawCols = "fuel_type, field_id, center_x, center_y, center_z, total, fueled, dry, capacity_mw, load_pct, waste";
      const hourlyCols = "fuel_type, field_id, center_x, center_y, center_z, total, fueled, dry, dry_min, dry_max, capacity_mw, load_pct, waste, waste_max";
      if (q.key == null || q.key === "") {
        rows = await all(db, sql(res, "gen_samples", "hourly_gen", rawCols, hourlyCols, "AND field_id = 0", "fuel_type"), from, to);
        break;
      }
      const lookup = await listLookup(db, "fields");
      const clusterWhere = res === "raw" ? "AND field_id IS NULL" : "AND field_id = -1";
      const resolve = (r: Row) => ({ ...r, field_id: resolveCenter({ x: Number(r.center_x), y: Number(r.center_y) }, lookup) });
      if (q.key === "all") {
        const raw = (await all(db, sql(res, "gen_samples", "hourly_gen", rawCols, hourlyCols, clusterWhere, "fuel_type, center_x, center_y"), from, to)).map(resolve);
        rows = res === "hourly" ? mergeHourly(raw, (r) => `${r.epoch}:${r.ts}:${r.fuel_type}:${r.field_id ?? `${r.cell_x}:${r.cell_y}`}`) : raw;
        break;
      }
      const field = lookup.find((l) => l.id === Number(q.key));
      if (!field) throw new NotFound(`unknown field ${q.key}`);
      if (field.x == null || field.y == null) { rows = []; break; }
      const c = { x: field.x, y: field.y };
      const raw = await all(db, sql(res, "gen_samples", "hourly_gen", rawCols, hourlyCols, `${clusterWhere} ${radiusWhere("center_x", "center_y")}`, "fuel_type, center_x"), from, to, ...radiusParams(c));
      const mine = raw.map(resolve).filter((r) => r.field_id === field.id);
      rows = res === "hourly" ? mergeHourly(mine, (r) => `${r.epoch}:${r.ts}:${r.fuel_type}`) : mine;
      break;
    }
    case "depot":
      rows = await all(db, sql(res, "depot_samples", "hourly_depot",
        "item, stock, capacity, is_full", "item, stock, stock_min, stock_max, capacity, is_full",
        "AND item = ? COLLATE NOCASE", "item"), from, to, q.key ?? "");
      break;
    case "prod":
      rows = await all(db, sql(res, "prod_samples", "hourly_prod",
        "item, produced_per_min, consumed_per_min, max_prod, max_cons", "item, produced_per_min, consumed_per_min, max_prod, max_cons",
        "AND item = ? COLLATE NOCASE", "item"), from, to, q.key ?? "");
      break;
    case "station":
      rows = await all(db, sql(res, "station_samples", "hourly_station",
        "station, platform, mode, cargo, transfer_rate, docked_train, inbound", "station, platform, mode, transfer_rate, docked, inbound",
        "AND station = ? COLLATE NOCASE", "platform"), from, to, q.key ?? "");
      break;
    case "sinks":
      rows = await all(db, sql(res, "sink_samples", "hourly_sink",
        "sink, coupons, points_to_next, points_per_min", "sink, coupons, coupons_max, points_to_next, points_per_min",
        "", "sink"), from, to);
      break;
    case "drone": {
      const cols = "station, paired, status, in_per_min, out_per_min, est_per_min, round_trip_s, trip_in, trip_out, fuel, input_stock, output_stock";
      const hourlyCols = "station, paired, status, in_per_min, out_per_min, est_per_min, round_trip_s, trip_in, trip_out, fuel, fuel_min, input_stock, output_stock";
      const one = q.key != null && q.key !== "" && q.key !== "all";
      rows = await all(db, sql(res, "drone_samples", "hourly_drone", cols, hourlyCols, one ? "AND station = ? COLLATE NOCASE" : "", "station"), from, to, ...(one ? [q.key] : []));
      break;
    }
    case "counter": {
      const cols = "counter_id, name, belt, cap_per_min, items_per_min, confidence";
      const hourlyCols = "counter_id, name, belt, cap_per_min, items_per_min, items_min, items_max, confidence";
      const one = q.key != null && q.key !== "" && q.key !== "all";
      // Counters have no player-facing name, so the key is FRM's ID; a name match is accepted too.
      rows = await all(db, sql(res, "counter_samples", "hourly_counter", cols, hourlyCols, one ? "AND (counter_id = ? OR name = ? COLLATE NOCASE)" : "", "counter_id"), from, to, ...(one ? [q.key, q.key] : []));
      break;
    }
  }
  return toSeries(rows, await gapsP, res);
}

export interface Visit { ts: number; epoch: number; session: string; station: string; train: string; arrived_ts: number; departed_ts: number | null; delta_cargo: number | null }

export async function readVisits(db: D1Database, q: { from: number; to: number; station?: string | null; train?: string | null }): Promise<Visit[]> {
  const where: string[] = [], params: unknown[] = [q.from, q.to];
  if (q.station) { where.push("AND station = ? COLLATE NOCASE"); params.push(q.station); }
  if (q.train) { where.push("AND train = ? COLLATE NOCASE"); params.push(q.train); }
  return all<Visit>(db,
    `SELECT ts, epoch, session, station, train, arrived_ts, departed_ts, delta_cargo FROM train_visits WHERE arrived_ts BETWEEN ? AND ? ${where.join(" ")} ORDER BY arrived_ts, station`,
    ...params);
}
