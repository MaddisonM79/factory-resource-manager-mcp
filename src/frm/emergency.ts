// Emergency dark-restart readiness. Power switches named *-EMERGENCY-RESERVE gate a battery
// bank that must stay isolated and full; *-TIE switches are the cut-off from the main grid.
// A dark restart is: open the ties, close the reserves, bring the grid back up behind them.
// Built from getSwitches + getPower, so it is live, not sampled.

import { asArray, num, loc } from "./client.ts";

export const RESERVE_SUFFIX = /-EMERGENCY-RESERVE$/i;
export const TIE_SUFFIX = /-TIE$/i;

export type Role = "reserve" | "tie";
export type Mode = "normal" | "dark-restart" | "mixed" | "none";

export interface GroupView {
  group: number;
  circuits: number[];
  capacityMW: number;
  productionMW: number;
  consumedMW: number;
  batteryPct: number | null;
  batteryMWh: number;
  batteryInMW: number;
  batteryOutMW: number;
  timeToEmpty: string | null;
  timeToFull: string | null;
  fuseTripped: boolean;
}

export interface SwitchRow {
  id: string;
  name: string;
  site: string;
  role: Role;
  isOn: boolean;
  expectedOn: boolean;
  ok: boolean;
  issues: string[];
  primaryCircuit: number;
  secondaryCircuit: number;
  primary: GroupView | null;
  secondary: GroupView | null;
  /** the isolated side of a reserve switch (null when the switch is closed and the sides are one group) */
  reserve: GroupView | null;
  location: string;
}

/** issues are deviations from the normal state; notes are things not built yet (a missing switch) and do not affect ok */
export interface SiteRow { site: string; reserve: SwitchRow | null; tie: SwitchRow | null; ok: boolean; issues: string[]; notes: string[] }

export interface EmergencyReport {
  mode: Mode;
  ready: boolean;
  minChargePct: number;
  mainGroup: number | null;
  sites: SiteRow[];
  switches: SwitchRow[];
  /** switches with neither suffix, for reference */
  otherSwitches: { id: string; name: string; isOn: boolean; location: string }[];
}

export function groupViews(power: unknown): GroupView[] {
  return asArray(power).map((g) => {
    const cap = num(g.BatteryCapacity);
    return {
      group: num(g.CircuitGroupID ?? g.CircuitID),
      circuits: asArray(g.AssociatedCircuits).map(num),
      capacityMW: num(g.PowerCapacity),
      productionMW: num(g.PowerProduction),
      consumedMW: num(g.PowerConsumed),
      batteryPct: cap > 0 ? num(g.BatteryPercent) : null,
      batteryMWh: cap,
      batteryInMW: num(g.BatteryInput),
      batteryOutMW: num(g.BatteryOutput),
      timeToEmpty: cap > 0 && g.BatteryTimeEmpty && g.BatteryTimeEmpty !== "00:00:00" ? String(g.BatteryTimeEmpty) : null,
      timeToFull: cap > 0 && g.BatteryTimeFull && g.BatteryTimeFull !== "00:00:00" ? String(g.BatteryTimeFull) : null,
      fuseTripped: !!g.FuseTriggered,
    };
  });
}

export const roleOf = (name: string): Role | null => (RESERVE_SUFFIX.test(name) ? "reserve" : TIE_SUFFIX.test(name) ? "tie" : null);
export const siteOf = (name: string): string => name.replace(RESERVE_SUFFIX, "").replace(TIE_SUFFIX, "").trim().toUpperCase();

const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 10) / 10}%`);

export function emergencyReport(switchesRaw: unknown, power: unknown, opts: { minChargePct?: number } = {}): EmergencyReport {
  const minChargePct = opts.minChargePct ?? 95;
  const groups = groupViews(power);
  const byCircuit = new Map<number, GroupView>();
  for (const g of groups) for (const c of g.circuits) byCircuit.set(c, g);
  const main = groups.length ? groups.reduce((a, b) => (b.capacityMW > a.capacityMW ? b : a)) : null;

  const switches: SwitchRow[] = [];
  const otherSwitches: EmergencyReport["otherSwitches"] = [];
  for (const s of asArray(switchesRaw)) {
    const name = String(s.SwitchTag ?? s.Name ?? "");
    const role = roleOf(name);
    const isOn = !!s.IsOn;
    if (!role) { otherSwitches.push({ id: String(s.ID), name, isOn, location: loc(s) }); continue; }
    const pc = num(s.Primary), sc = num(s.Secondary);
    const primary = byCircuit.get(pc) ?? null, secondary = byCircuit.get(sc) ?? null;
    const issues: string[] = [];
    let reserve: GroupView | null = null;
    if (role === "reserve") {
      if (isOn) issues.push("switch is closed: the reserve is bridged to the grid instead of held back");
      const sides = [primary, secondary].filter((g): g is GroupView => !!g);
      const isolated = sides.filter((g) => !main || g.group !== main.group);
      // Closed switch: both sides are the same group, nothing is "behind" it. Open: the side that is not the grid.
      reserve = primary && secondary && primary.group === secondary.group ? null
        : isolated.length ? isolated.reduce((a, b) => (b.capacityMW < a.capacityMW ? b : a)) : null;
      if (!isOn && !reserve) issues.push("cannot see a circuit behind the switch (no power group for either side)");
      if (reserve) {
        if (reserve.batteryMWh <= 0) issues.push("no battery behind the switch");
        else if (reserve.batteryPct != null && reserve.batteryPct < minChargePct) issues.push(`battery at ${pct(reserve.batteryPct)}, below ${minChargePct}%`);
        if (reserve.batteryOutMW > 0) issues.push(`reserve is discharging at ${Math.round(reserve.batteryOutMW)} MW${reserve.timeToEmpty ? `, empty in ${reserve.timeToEmpty}` : ""}`);
        if (reserve.consumedMW > 0 && reserve.productionMW === 0) issues.push(`${Math.round(reserve.consumedMW)} MW of load on the isolated side with no generation`);
        if (reserve.fuseTripped) issues.push("fuse tripped on the reserve side");
      } else if (isOn) {
        const g = primary ?? secondary;
        if (g && g.batteryMWh > 0 && g.batteryPct != null && g.batteryPct < minChargePct) issues.push(`grid battery at ${pct(g.batteryPct)}, below ${minChargePct}%`);
      }
    } else {
      if (!isOn) issues.push("tie is open: this site is cut off from the main grid");
      for (const [label, g] of [["primary", primary], ["secondary", secondary]] as const) if (g?.fuseTripped) issues.push(`fuse tripped on the ${label} side`);
    }
    const expectedOn = role === "tie";
    switches.push({
      id: String(s.ID), name, site: siteOf(name), role, isOn, expectedOn, ok: issues.length === 0, issues,
      primaryCircuit: pc, secondaryCircuit: sc, primary, secondary, reserve, location: loc(s),
    });
  }

  const siteNames = [...new Set(switches.map((s) => s.site))].sort();
  const sites: SiteRow[] = siteNames.map((site) => {
    const reserve = switches.find((s) => s.site === site && s.role === "reserve") ?? null;
    const tie = switches.find((s) => s.site === site && s.role === "tie") ?? null;
    const issues = [...(reserve?.issues ?? []), ...(tie?.issues ?? [])];
    const notes: string[] = [];
    if (!reserve) notes.push("no *-EMERGENCY-RESERVE switch for this site yet");
    if (!tie) notes.push("no *-TIE switch for this site yet");
    return { site, reserve, tie, ok: issues.length === 0, issues, notes };
  });

  const reserves = switches.filter((s) => s.role === "reserve"), ties = switches.filter((s) => s.role === "tie");
  const anyTieOpen = ties.some((s) => !s.isOn), anyReserveClosed = reserves.some((s) => s.isOn);
  const mode: Mode = !switches.length ? "none"
    : !anyTieOpen && !anyReserveClosed ? "normal"
    : anyTieOpen && anyReserveClosed && ties.every((s) => !s.isOn) && reserves.every((s) => s.isOn) ? "dark-restart"
    : "mixed";
  // Ready = every reserve is held back and full. Missing ties are listed per site but do not block readiness.
  const ready = mode === "normal" && reserves.length > 0 && reserves.every((s) => s.ok);

  return { mode, ready, minChargePct, mainGroup: main?.group ?? null, sites, switches, otherSwitches };
}
