// Rail network view: every train with its timetable, position and cargo, every station with its
// platforms, what is docked or inbound, and which trains have it on their schedule, plus every
// signal with its aspect and block validity. Live from getTrains + getTrainStation (+ getTrainSignals);
// dock history (dwell, cargo moved) comes from train_visits in D1.

import { asArray, num, loc } from "./client.ts";
import type { TrainCadence } from "../history/store.ts";

export interface Cargo { name: string; amount: number }

export interface TrainRow {
  id: string;
  name: string;
  status: string;
  /** derived: docked | moving | stopped | derailed */
  state: "docked" | "moving" | "stopped" | "derailed";
  speed: number;
  derailed: boolean;
  pendingDerail: boolean;
  /** the station FRM reports for the train: where it is docked, or where it is heading */
  station: string | null;
  docking: string;
  timetable: string[];
  timetableIndex: number;
  nextStop: string | null;
  errors: string[];
  /** set when the train has gone without docking for longer than its own cadence allows; see applyOverdue */
  overdue: Overdue | null;
  cars: number;
  locomotives: number;
  payloadPct: number | null;
  payloadT: number;
  maxPayloadT: number;
  cargo: Cargo[];
  powerMW: number;
  fuseTripped: boolean;
  location: string;
}

export interface PlatformRow { index: number; mode: "load" | "unload"; status: string; docking: string; transferRate: number; inventory: Cargo[]; stock: number }

export interface StationRow {
  id: string;
  name: string;
  location: string;
  transferRate: number;
  platforms: PlatformRow[];
  stock: number;
  /** items with the most stock across the platforms */
  topItems: Cargo[];
  docked: string | null;
  inbound: string[];
  /** trains with this station on their timetable */
  scheduled: string[];
  fuseTripped: boolean;
}

export interface SignalRow {
  id: string;
  /** block | path, from the class name */
  kind: "block" | "path";
  /** None | Clear | Stop | Dock */
  aspect: string;
  /** Valid | Unvalidated | No Exit Signal | Contains Loop | Contains Mixed Entry Signals | Contain Station */
  block: string;
  blockOk: boolean;
  location: string;
}

export interface Overdue {
  /** seconds since the last recorded dock, with sampler gaps (origin down) taken out */
  since_s: number;
  /** the train's median dock-to-dock interval over the last day, or null when there is no baseline */
  usual_s: number | null;
  /** since_s crossed this to be flagged: 2x usual (floor 30 min), or 60 min with no baseline */
  threshold_s: number;
  last_arrival: number | null;
}

export interface TrainsReport {
  counts: {
    trains: number; moving: number; docked: number; stopped: number; derailed: number; overdue: number; stations: number; platforms: number;
    signals: number; signalsStop: number; invalidBlocks: number;
  };
  trains: TrainRow[];
  stations: StationRow[];
  signals: SignalRow[];
}

/**
 * Block validation as FRM reports it. Shipping builds of the game strip enum display names, so the
 * live value is the raw enum name (RBV_Valid); an editor build would say "Valid". Both are normalised.
 */
const BLOCK_NAMES: Record<string, string> = {
  RBV_Unvalidated: "Unvalidated", RBV_Valid: "Valid", RBV_NoExitSignals: "No Exit Signal", RBV_ContainsLoop: "Contains Loop",
  RBV_ContainsMixedEntrySignals: "Contains Mixed Entry Signals", RBV_ContainsStation: "Contain Station",
};
export function blockValidation(raw: unknown): string {
  const s = String(raw ?? "");
  return BLOCK_NAMES[s] ?? s;
}

/**
 * FRM 1.5.3 labels a signal's Aspect with the ERailroadBlockValidation enum by mistake (the aspect
 * index is looked up in the wrong enum), so the aspect arrives as a block-validation name whose
 * position matches the real aspect: index 0 None, 1 Clear, 2 Stop, 3 Dock. Live shipping builds
 * send the raw enum names (RBV_NoExitSignals = Stop); editor builds would send display names.
 * Correct aspect names (with or without their RSA_ prefix) pass through, so a fixed FRM keeps working.
 */
const ASPECT_BY_MISLABEL: Record<string, string> = {
  RBV_Unvalidated: "None", RBV_Valid: "Clear", RBV_NoExitSignals: "Stop", RBV_ContainsLoop: "Dock",
  Unvalidated: "None", Valid: "Clear", "No Exit Signal": "Stop", "Contains Loop": "Dock",
};
const ASPECTS = new Set(["None", "Clear", "Stop", "Dock"]);
export function signalAspect(raw: unknown): string {
  const s = String(raw ?? "").replace(/^RSA_/, "");
  if (ASPECTS.has(s)) return s;
  return ASPECT_BY_MISLABEL[s] ?? s;
}

export function signalRows(signalsRaw: unknown): SignalRow[] {
  return asArray(signalsRaw).map((s) => {
    const block = blockValidation(s.BlockValid);
    return {
      id: String(s.ID ?? ""),
      kind: /path/i.test(String(s.ClassName ?? s.Name ?? "")) ? "path" : "block",
      aspect: signalAspect(s.Aspect),
      block, blockOk: block === "Valid",
      location: loc(s),
    };
  });
}

const DOCKED = /docked|docking|loading|unloading/i;
export const isDocked = (t: any): boolean => DOCKED.test(String(t.Docking ?? "")) && !/none/i.test(String(t.Docking ?? ""));

export function trainRows(trainsRaw: unknown): TrainRow[] {
  return asArray(trainsRaw).map((t) => {
    const cargo = new Map<string, number>();
    let locomotives = 0;
    for (const v of asArray(t.Vehicles)) {
      if (/locomotive/i.test(String(v.ClassName ?? v.Name ?? ""))) locomotives++;
      for (const i of asArray(v.Inventory)) cargo.set(String(i.Name), (cargo.get(String(i.Name)) ?? 0) + num(i.Amount ?? i.amount));
    }
    const timetable = asArray(t.TimeTable).map((s: any) => String(s.StationName ?? s.Name ?? ""));
    const idx = num(t.TimeTableIndex);
    const derailed = !!t.Derailed;
    const docked = isDocked(t);
    const speed = Math.round(num(t.ForwardSpeed));
    const errors: string[] = [];
    if (derailed) errors.push("derailed");
    if (t.PendingDerail) errors.push("derail pending");
    if (t.SelfDriving && !/NoError/i.test(String(t.SelfDriving))) errors.push(`autopilot: ${String(t.SelfDriving).replace(/^SDLE_/, "")}`);
    if (t.Path && !/NoError/i.test(String(t.Path))) errors.push(`path: ${String(t.Path).replace(/^PDE_/, "")}`);
    if (t.PowerInfo?.FuseTriggered) errors.push("fuse tripped");
    if (!timetable.length) errors.push("no timetable");
    return {
      id: String(t.ID), name: String(t.Name ?? ""), status: String(t.Status ?? ""),
      state: derailed ? "derailed" : docked ? "docked" : speed > 0 ? "moving" : "stopped",
      speed, derailed, pendingDerail: !!t.PendingDerail,
      station: t.TrainStation ? String(t.TrainStation) : null,
      docking: String(t.Docking ?? "").replace(/^TDS_/, ""),
      timetable, timetableIndex: idx, nextStop: timetable[idx] ?? null,
      errors, overdue: null, cars: asArray(t.Vehicles).length, locomotives,
      payloadPct: num(t.MaxPayloadMass) ? Math.round((num(t.PayloadMass) / num(t.MaxPayloadMass)) * 100) : null,
      payloadT: Math.round(num(t.PayloadMass) / 1000), maxPayloadT: Math.round(num(t.MaxPayloadMass) / 1000),
      cargo: [...cargo].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      powerMW: Math.round(num(t.PowerInfo?.PowerConsumed) * 10) / 10, fuseTripped: !!t.PowerInfo?.FuseTriggered,
      location: loc(t),
    };
  });
}

export function stationRows(stationsRaw: unknown, trains: TrainRow[]): StationRow[] {
  return asArray(stationsRaw).map((s) => {
    const name = String(s.Name ?? "");
    const platforms: PlatformRow[] = asArray(s.CargoInventory).map((p: any, i: number) => {
      const inventory = asArray(p.Inventory).map((x: any) => ({ name: String(x.Name), amount: num(x.Amount ?? x.amount) })).filter((x: Cargo) => x.amount > 0);
      return {
        index: i, mode: /unload/i.test(String(p.LoadingMode ?? "")) ? "unload" : "load",
        status: String(p.LoadingStatus ?? ""), docking: String(p.DockingStatus ?? ""),
        transferRate: num(p.TransferRate), inventory, stock: inventory.reduce((n: number, x: Cargo) => n + x.amount, 0),
      };
    });
    const totals = new Map<string, number>();
    for (const p of platforms) for (const x of p.inventory) totals.set(x.name, (totals.get(x.name) ?? 0) + x.amount);
    const here = trains.filter((t) => t.station === name);
    return {
      id: String(s.ID), name, location: loc(s), transferRate: num(s.TransferRate), platforms,
      stock: [...totals.values()].reduce((a, b) => a + b, 0),
      topItems: [...totals].map(([n, amount]) => ({ name: n, amount })).sort((a, b) => b.amount - a.amount).slice(0, 3),
      docked: here.find((t) => t.state === "docked")?.name ?? null,
      inbound: here.filter((t) => t.state !== "docked").map((t) => t.name),
      scheduled: trains.filter((t) => t.timetable.includes(name)).map((t) => t.name),
      fuseTripped: !!s.PowerInfo?.FuseTriggered,
    };
  });
}

export function trainsReport(trainsRaw: unknown, stationsRaw: unknown, signalsRaw: unknown = null): TrainsReport {
  const trains = trainRows(trainsRaw).sort((a, b) => a.name.localeCompare(b.name));
  const stations = stationRows(stationsRaw, trains).sort((a, b) => a.name.localeCompare(b.name));
  // Problems first: invalid blocks, then Stop aspects, then the rest.
  const rank = (s: SignalRow) => (s.blockOk ? 0 : 2) + (s.aspect === "Stop" ? 1 : 0);
  const signals = signalRows(signalsRaw).sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const by = (st: TrainRow["state"]) => trains.filter((t) => t.state === st).length;
  return {
    counts: {
      trains: trains.length, moving: by("moving"), docked: by("docked"), stopped: by("stopped"), derailed: by("derailed"), overdue: 0,
      stations: stations.length, platforms: stations.reduce((n, s) => n + s.platforms.length, 0),
      signals: signals.length, signalsStop: signals.filter((s) => s.aspect === "Stop").length, invalidBlocks: signals.filter((s) => !s.blockOk).length,
    },
    trains, stations, signals,
  };
}

// ---------------------------------------------------------------- overdue

export const OVERDUE_FLOOR_S = 30 * 60;
export const OVERDUE_NO_BASELINE_S = 60 * 60;
export const OVERDUE_MULTIPLIER = 2;

export const durText = (s: number): string => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/**
 * A train that FRM says is fine (no derail, autopilot and path NoError) can still be stuck: two
 * trains waiting on each other at a path signal report speed 0, Docking None, and nothing else.
 * The tell is time since its last recorded dock against its own cadence. Docked trains, trains
 * under manual control, and trains without a timetable are never overdue (the last two carry
 * their own signal). With no cadence in the window at all the train is judged against a flat
 * hour, but only once the sampler has recorded visits for other trains (so a fresh database or
 * a fresh train does not light up every row).
 */
export function overdueOf(t: TrainRow, c: TrainCadence | undefined, now: number, recording: boolean): Overdue | null {
  if (t.state === "docked" || t.derailed || !t.timetable.length || !/self-driving/i.test(t.status)) return null;
  if (!c) {
    if (!recording) return null;
    // No arrival in the window: the window itself is the elapsed time.
    return { since_s: 24 * 3600, usual_s: null, threshold_s: 24 * 3600, last_arrival: null };
  }
  const since = Math.max(0, now - c.last_arrival - c.gap_s);
  const threshold = c.usual_s == null ? OVERDUE_NO_BASELINE_S : Math.max(OVERDUE_FLOOR_S, OVERDUE_MULTIPLIER * c.usual_s);
  if (since < threshold) return null;
  return { since_s: since, usual_s: c.usual_s, threshold_s: threshold, last_arrival: c.last_arrival };
}

export const overdueText = (o: Overdue): string =>
  o.last_arrival == null ? "overdue: no dock recorded in the last 24 h" : `overdue: no dock for ${durText(o.since_s)}${o.usual_s != null ? ` (usual ${durText(o.usual_s)})` : ""}`;

/** Stamp overdue onto the report's trains (as a field and an error line) and count them. */
export function applyOverdue(report: TrainsReport, cadence: Record<string, TrainCadence>, now: number, recording: boolean): TrainsReport {
  const trains = report.trains.map((t) => {
    const overdue = overdueOf(t, cadence[t.name], now, recording);
    return overdue ? { ...t, overdue, errors: [...t.errors, overdueText(overdue)] } : t;
  });
  return { ...report, trains, counts: { ...report.counts, overdue: trains.filter((t) => t.overdue).length } };
}
