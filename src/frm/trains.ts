// Rail network view: every train with its timetable, position and cargo, every station with its
// platforms, what is docked or inbound, and which trains have it on their schedule, plus every
// signal with its aspect and block validity. Live from getTrains + getTrainStation (+ getTrainSignals);
// dock history (dwell, cargo moved) comes from train_visits in D1.

import { asArray, num, loc } from "./client.ts";

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

export interface TrainsReport {
  counts: {
    trains: number; moving: number; docked: number; stopped: number; derailed: number; stations: number; platforms: number;
    signals: number; signalsStop: number; invalidBlocks: number;
  };
  trains: TrainRow[];
  stations: StationRow[];
  signals: SignalRow[];
}

/**
 * FRM 1.5 labels a signal's Aspect with the ERailroadBlockValidation enum's display names by mistake
 * (the aspect index is looked up in the wrong enum), so "Valid" means Clear and "No Exit Signal" means
 * Stop. Both the mislabelled and the correct names are accepted, so a fixed FRM keeps working.
 */
const ASPECT_BY_MISLABEL: Record<string, string> = { Unvalidated: "None", Valid: "Clear", "No Exit Signal": "Stop", "Contains Loop": "Dock" };
const ASPECTS = new Set(["None", "Clear", "Stop", "Dock"]);
export function signalAspect(raw: unknown): string {
  const s = String(raw ?? "");
  if (ASPECTS.has(s)) return s;
  return ASPECT_BY_MISLABEL[s] ?? s;
}

export function signalRows(signalsRaw: unknown): SignalRow[] {
  return asArray(signalsRaw).map((s) => {
    const block = String(s.BlockValid ?? "");
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
      errors, cars: asArray(t.Vehicles).length, locomotives,
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
      trains: trains.length, moving: by("moving"), docked: by("docked"), stopped: by("stopped"), derailed: by("derailed"),
      stations: stations.length, platforms: stations.reduce((n, s) => n + s.platforms.length, 0),
      signals: signals.length, signalsStop: signals.filter((s) => s.aspect === "Stop").length, invalidBlocks: signals.filter((s) => !s.blockOk).length,
    },
    trains, stations, signals,
  };
}
