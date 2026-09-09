// Read API for the history tables and the live KV ring. Mounted behind the OAuth
// provider at /api/ (same bearer token as /mcp) and behind the Hanko session check
// on the dashboard host. Read-only except renaming lookup rows. Only /api/status,
// /api/emergency and /api/trains reach the FRM tunnel, so the dashboard's live views
// come from a live answer rather than from sampler staleness.

import { Hono } from "hono";
import { type Env, readSamples, frmGet, asArray, loc, num } from "../frm/client.ts";
import { RAW_RETENTION_SECONDS, pickRes, type Res } from "../history/history.ts";
import { emergencyReport } from "../frm/emergency.ts";
import { trainsReport, applyOverdue } from "../frm/trains.ts";
import { readSeries, readVisits, readLatest, readTrainCadence, listLookup, insertLookup, updateLookup, NotFound, type Series, type SeriesKind } from "../history/store.ts";
import { collectAlerts } from "./alerts.ts";

export interface SeriesRequest { kind: SeriesKind; key?: string | null; from: number; to: number; res?: string | null }

/** One series, or one per epoch when the range spans several. Shared by the HTTP routes and the `trend` MCP tool. */
export async function querySeries(env: Env, r: SeriesRequest, now = Math.floor(Date.now() / 1000)): Promise<Series | Series[]> {
  const res: Res = pickRes(r.from, r.to, now, r.res);
  const out = await readSeries(env.DB, { kind: r.kind, key: r.key, from: r.from, to: r.to, res });
  if (out.length === 1) return out[0];
  if (out.length === 0) return { epoch: null as unknown as number, session: "", res, points: [], gaps: [] };
  return out;
}

const api = new Hono<{ Bindings: Env }>();

function range(c: any, now: number): { from: number; to: number; res: string | null } {
  const to = c.req.query("to") != null ? Number(c.req.query("to")) : now;
  const from = c.req.query("from") != null ? Number(c.req.query("from")) : to - 24 * 3600;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new BadRequest("from/to must be unix seconds with from <= to");
  const res = c.req.query("res") ?? null;
  if (res != null && res !== "raw" && res !== "hourly") throw new BadRequest("res must be raw or hourly");
  return { from: Math.floor(from), to: Math.floor(to), res };
}

export class BadRequest extends Error {}

/** Shared by this app and the dashboard, which mounts these routes (a sub-app's onError is not inherited). */
export function apiError(e: Error, c: any): Response {
  if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
  if (e instanceof NotFound) return c.json({ error: e.message }, 404);
  console.error("api:", e);
  return c.json({ error: e.message ?? String(e) }, 500);
}

api.onError(apiError);

/** Live "is the game up" for the dashboard header: FRM answered just now, or why not. */
api.get("/api/status", async (c) => {
  const now = Date.now();
  const ringP = readSamples(c.env).catch(() => []);
  let session: any = null, players: any[] = [], uobjects: { count: number; capacity: number; used_pct: number | null } | null = null, error: string | null = null;
  try {
    const [s, p, u] = await Promise.all([frmGet(c.env, "getSessionInfo"), frmGet(c.env, "getPlayer").catch(() => []), frmGet(c.env, "getUObjectCount").catch(() => null)]);
    session = s;
    players = asArray(p).map((x) => ({ name: x.PlayerName ?? x.Name, online: x.Online, location: loc(x), health: x.PlayerHP }));
    // The engine's object pool: the game crashes when it fills, so the header keeps an eye on it.
    const uo: any = asArray(u)[0];
    if (uo) { const count = num(uo.UObjectCount), capacity = num(uo.UObjectCapacity); uobjects = { count, capacity, used_pct: capacity ? Math.round((count / capacity) * 1000) / 10 : null }; }
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  const ring = await ringP;
  const latest = ring[ring.length - 1] ?? null;
  return c.json({
    now: Math.floor(now / 1000),
    reachable: error == null,
    error,
    session: session && {
      name: session.SessionName, paused: !!session.IsPaused, is_day: !!session.IsDay,
      play_seconds: session.TotalPlayDuration, play_text: session.TotalPlayDurationText, days: session.PassedDays,
      hours: session.Hours, minutes: session.Minutes,
    },
    players,
    uobjects,
    sampler: {
      latest_ts: latest ? Math.floor(latest.t / 1000) : null,
      staleness_seconds: latest ? Math.floor((now - latest.t) / 1000) : null,
      gap: latest?.gap ?? null,
    },
  });
});

/** Newest good tick from every history table, for tables and pickers. */
/** Dark-restart readiness: *-EMERGENCY-RESERVE and *-TIE switches and the batteries behind them. Live. */
api.get("/api/emergency", async (c) => {
  const min = Number(c.req.query("min_charge_pct") ?? 95);
  if (!Number.isFinite(min) || min < 0 || min > 100) throw new BadRequest("min_charge_pct must be 0..100");
  const [switches, power] = await Promise.all([frmGet(c.env, "getSwitches"), frmGet(c.env, "getPower")]);
  return c.json({ now: Math.floor(Date.now() / 1000), ...emergencyReport(switches, power, { minChargePct: min }) });
});

/** Rail network, live: trains with timetables and cargo, stations with platforms, docked and inbound, signals and their blocks. */
api.get("/api/trains", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const [trains, stations, signals, cad] = await Promise.all([
    frmGet(c.env, "getTrains"), frmGet(c.env, "getTrainStation"),
    // Older FRM has no getTrainSignals; the report then simply has no signals.
    frmGet(c.env, "getTrainSignals").catch(() => null),
    // Dock cadence from D1: a train stuck at a signal looks healthy to FRM, so overdue is judged against history.
    readTrainCadence(c.env.DB, now),
  ]);
  return c.json({ now, ...applyOverdue(trainsReport(trains, stations, signals), cad.cadence, now, cad.visits > 0) });
});

/** The global alert strip: origin, sampler, object pool, trains (derailed, errors, overdue), signals, fuses, dry generators, rollup. */
api.get("/api/alerts", async (c) => c.json(await collectAlerts(c.env)));

api.get("/api/latest", async (c) => {
  const latest = await readLatest(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  return c.json({ ...latest, now, staleness_seconds: latest.ts == null ? null : now - latest.ts });
});

api.get("/api/live", async (c) => {
  const ring = await readSamples(c.env);
  const minutes = Number(c.req.query("minutes") ?? 1440);
  const now = Date.now();
  const cut = now - (Number.isFinite(minutes) ? minutes : 1440) * 60_000;
  const latest = ring[ring.length - 1] ?? null;
  return c.json({
    now: Math.floor(now / 1000),
    staleness_seconds: latest ? Math.floor((now - latest.t) / 1000) : null,
    gap: latest?.gap ?? null,
    latest,
    ring: ring.filter((s) => s.t >= cut),
    raw_retention_seconds: RAW_RETENTION_SECONDS,
  });
});

const series = (kind: SeriesKind, keyOf: (c: any) => string | null | undefined) => async (c: any) => {
  const now = Math.floor(Date.now() / 1000);
  const { from, to, res } = range(c, now);
  return c.json(await querySeries(c.env, { kind, key: keyOf(c), from, to, res }, now));
};

api.get("/api/series/power", series("power", (c) => c.req.query("group")));
api.get("/api/series/site", series("site", () => "all"));
api.get("/api/series/site/:id", series("site", (c) => c.req.param("id")));
api.get("/api/series/gens", series("gens", (c) => c.req.query("field")));
api.get("/api/series/depot/:item", series("depot", (c) => c.req.param("item")));
api.get("/api/series/prod/:item", series("prod", (c) => c.req.param("item")));
api.get("/api/series/station/:name", series("station", (c) => c.req.param("name")));
api.get("/api/series/sinks", series("sinks", () => null));
api.get("/api/series/drone", series("drone", () => "all"));
api.get("/api/series/drone/:station", series("drone", (c) => c.req.param("station")));
api.get("/api/series/counter", series("counter", () => "all"));
api.get("/api/series/counter/:id", series("counter", (c) => c.req.param("id")));

api.get("/api/visits", async (c) => {
  const { from, to } = range(c, Math.floor(Date.now() / 1000));
  return c.json({ from, to, visits: await readVisits(c.env.DB, { from, to, station: c.req.query("station"), train: c.req.query("train") }) });
});

/** Lookup rows: name, and coordinates that may be set, changed, or cleared (null) so the sampler re-seeds them. */
function lookupBody(body: any, requireName: boolean): { name?: string; x?: number | null; y?: number | null; z?: number | null } {
  if (!body || typeof body !== "object") throw new BadRequest("a JSON body {name?, x?, y?, z?}");
  const patch: { name?: string; x?: number | null; y?: number | null; z?: number | null } = {};
  if (body.name !== undefined || requireName) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new BadRequest("name must be a non-empty string");
    patch.name = body.name.trim().slice(0, 80);
  }
  for (const k of ["x", "y", "z"] as const) {
    if (body[k] === undefined) continue;
    if (body[k] === null) { patch[k] = null; continue; }
    if (typeof body[k] !== "number" || !Number.isFinite(body[k])) throw new BadRequest(`${k} must be a number or null`);
    patch[k] = body[k];
  }
  return patch;
}

for (const table of ["sites", "fields"] as const) {
  api.get(`/api/lookup/${table}`, async (c) => c.json(await listLookup(c.env.DB, table)));
  api.post(`/api/lookup/${table}`, async (c) => {
    const row = lookupBody(await c.req.json().catch(() => null), true);
    return c.json(await insertLookup(c.env.DB, table, { name: row.name!, x: row.x, y: row.y, z: row.z }), 201);
  });
  api.patch(`/api/lookup/${table}/:id`, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new BadRequest("integer id");
    const row = await updateLookup(c.env.DB, table, id, lookupBody(await c.req.json().catch(() => null), false));
    if (!row) throw new NotFound(`no ${table} row ${id}`);
    return c.json(row);
  });
}

api.notFound((c) => c.json({ error: "not found" }, 404));

export { api };
