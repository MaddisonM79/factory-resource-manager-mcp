// Global alerts for the dashboard strip: one list of what needs a human right now, drawn from
// the live origin (session, object pool, trains) and the newest history tick (power, generators).
// buildAlerts is pure so the rules are testable; collectAlerts gathers its inputs.

import { type Env, readSamples, frmGet, asArray, num } from "../frm/client.ts";
import { trainsReport, applyOverdue, durText, type TrainsReport } from "../frm/trains.ts";
import { readLatest, readTrainCadence, type Latest } from "../history/store.ts";
import { readRollupMark } from "../history/sampler.ts";

export type Level = "bad" | "warn";

export interface Alert {
  level: Level;
  /** stable id for the rule + subject, so the client can diff (e.g. "train-overdue:FUEL-PLASTIC") */
  id: string;
  title: string;
  detail: string;
  /** dashboard tab that shows the underlying data */
  tab: "overview" | "power" | "trains" | "gens" | "admin";
}

export interface AlertInputs {
  now: number;
  origin: { reachable: boolean; error: string | null; uobjectsPct: number | null };
  sampler: { staleness_s: number | null; gap: boolean };
  latest: Latest | null;
  trains: TrainsReport | null;
  /** unix seconds of the last daily rollup, null if it never ran */
  rollupAt: number | null;
}

export const STALE_SAMPLER_S = 15 * 60;
export const ROLLUP_LATE_S = 26 * 3600;
export const DRY_FRACTION = 0.25;

export function buildAlerts(i: AlertInputs): Alert[] {
  const out: Alert[] = [];
  const add = (level: Level, id: string, title: string, detail: string, tab: Alert["tab"]) => out.push({ level, id, title, detail, tab });

  if (!i.origin.reachable) add("bad", "origin", "Game server unreachable", (i.origin.error ?? "FRM did not answer").slice(0, 120), "admin");
  if (i.sampler.gap || (i.sampler.staleness_s != null && i.sampler.staleness_s > STALE_SAMPLER_S)) {
    add("bad", "sampler", "Sampler behind", i.sampler.gap ? `last tick was a gap, ${durText(i.sampler.staleness_s ?? 0)} ago` : `last sample ${durText(i.sampler.staleness_s ?? 0)} ago`, "admin");
  }
  const uo = i.origin.uobjectsPct;
  if (uo != null && uo >= 75) add(uo >= 90 ? "bad" : "warn", "uobjects", `Object pool ${uo.toFixed(1)}% full`, "the game crashes when the engine's UObject pool fills", "overview");

  if (i.trains) {
    for (const t of i.trains.trains) {
      if (t.derailed) add("bad", `train-derailed:${t.name}`, `${t.name} derailed`, `at ${t.location}`, "trains");
      else if (t.overdue) add("bad", `train-overdue:${t.name}`, `${t.name} overdue`, `${t.errors[t.errors.length - 1].replace(/^overdue: /, "")}${t.nextStop ? ` · heading to ${t.nextStop}` : ""}`, "trains");
      else if (t.errors.length) add("bad", `train-error:${t.name}`, `${t.name}: ${t.errors[0]}`, t.errors.slice(1).join("; ") || `at ${t.location}`, "trains");
    }
    if (i.trains.counts.invalidBlocks) add("warn", "signals", `${i.trains.counts.invalidBlocks} invalid signal block${i.trains.counts.invalidBlocks === 1 ? "" : "s"}`, "trains cannot path through an invalid block", "trains");
  }

  const L = i.latest;
  if (L) {
    for (const r of L.power) {
      const g = String(r.circuit_group);
      if (num(r.fuse_tripped)) add("bad", `fuse:${g}`, `Fuse tripped on circuit group ${g}`, `${num(r.max_consumed_mw).toFixed(0)} MW peak against ${num(r.capacity_mw).toFixed(0)} MW capacity`, "power");
      else if (num(r.capacity_mw) > 0 && num(r.max_consumed_mw) > num(r.capacity_mw)) add("warn", `peak:${g}`, `Peak draw exceeds capacity on circuit group ${g}`, `${num(r.max_consumed_mw).toFixed(0)} MW peak, ${num(r.capacity_mw).toFixed(0)} MW capacity`, "power");
    }
    for (const g of L.gens) {
      if (num(g.field_id) !== 0) continue; // map-wide rows only
      const total = num(g.total), dry = num(g.dry);
      if (total >= 4 && dry / total >= DRY_FRACTION) add("warn", `dry:${g.fuel_type}`, `${dry} of ${total} ${g.fuel_type} generators dry`, "fuel is not keeping up", "gens");
    }
  }

  if (i.rollupAt != null && i.now - i.rollupAt > ROLLUP_LATE_S) add("warn", "rollup", "History rollup has not run", `last run ${durText(i.now - i.rollupAt)} ago; raw samples are only kept for 7 days`, "admin");

  const rank = (a: Alert) => (a.level === "bad" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export interface AlertsResponse { now: number; alerts: Alert[]; checks: { trains: boolean; latest: boolean } }

/** Everything buildAlerts needs, gathered in parallel; a failed trains fetch drops those rules rather than the whole list. */
export async function collectAlerts(env: Env, now = Math.floor(Date.now() / 1000)): Promise<AlertsResponse> {
  const originP = (async () => {
    try {
      const [, u] = await Promise.all([frmGet(env, "getSessionInfo"), frmGet(env, "getUObjectCount").catch(() => null)]);
      const uo: any = asArray(u)[0];
      const pct = uo && num(uo.UObjectCapacity) ? (num(uo.UObjectCount) / num(uo.UObjectCapacity)) * 100 : null;
      return { reachable: true, error: null, uobjectsPct: pct };
    } catch (e: any) { return { reachable: false, error: String(e?.message ?? e), uobjectsPct: null }; }
  })();
  const trainsP = (async () => {
    try {
      const [trains, stations, signals, cad] = await Promise.all([
        frmGet(env, "getTrains"), frmGet(env, "getTrainStation"), frmGet(env, "getTrainSignals").catch(() => null), readTrainCadence(env.DB, now),
      ]);
      return applyOverdue(trainsReport(trains, stations, signals), cad.cadence, now, cad.visits > 0);
    } catch { return null; }
  })();
  const [origin, trains, latest, ring, mark] = await Promise.all([
    originP, trainsP, readLatest(env.DB).catch(() => null), readSamples(env).catch(() => []), readRollupMark(env),
  ]);
  const last = ring[ring.length - 1] ?? null;
  const alerts = buildAlerts({
    now, origin, trains, latest, rollupAt: mark?.at ?? null,
    sampler: { staleness_s: last ? Math.floor(now - last.t / 1000) : null, gap: !!last?.gap },
  });
  return { now, alerts, checks: { trains: trains != null, latest: latest != null } };
}
