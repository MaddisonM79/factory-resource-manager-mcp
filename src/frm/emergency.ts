// Emergency dark-restart readiness. Power switches named *-EMERGENCY-RESERVE gate a battery
// bank that must stay isolated and full: the switch is OFF in normal operation. *-TIE switches
// are the site's cut-off from the main grid: ON in normal operation. A dark restart turns the
// ties off and the reserves on, then brings the grid back up behind them.
// Vocabulary is on/off throughout (FRM's IsOn, which tracks the real switch); "open" means
// different things to different people. Each side of a switch is a circuit ID, and getPower
// groups the circuits that are joined, so the topology is a cross-check: an OFF switch whose two
// sides still resolve to one power group is being bypassed by another cable path and does not
// isolate anything by itself. Built from getSwitches + getPower, so it is live, not sampled.

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
  /** bank size */
  batteryMWh: number;
  /** energy actually held right now: pct × size */
  storedMWh: number | null;
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
  /** both sides resolve to the same power group: joined, by this switch (on) or by another path (off) */
  sidesJoined: boolean;
  expectedOn: boolean;
  ok: boolean;
  issues: string[];
  /** things not finished rather than wrong, e.g. a side with no cable */
  notes: string[];
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
      storedMWh: cap > 0 ? Math.round(cap * num(g.BatteryPercent)) / 100 : null,
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
    const pc = num(s.Primary), sc = num(s.Secondary);
    if (!role) { otherSwitches.push({ id: String(s.ID), name, isOn, location: loc(s) }); continue; }
    const primary = byCircuit.get(pc) ?? null, secondary = byCircuit.get(sc) ?? null;
    const sidesJoined = !!primary && !!secondary && primary.group === secondary.group;
    const issues: string[] = [];
    const notes: string[] = [];
    if (pc < 0 || sc < 0) notes.push(`nothing wired to the ${pc < 0 && sc < 0 ? "switch" : pc < 0 ? "primary side" : "secondary side"} yet`);
    else if (!isOn && sidesJoined) notes.push(`switch is off but both sides are still power group ${primary!.group}: another cable path joins them, so this switch alone does not ${role === "tie" ? "cut the site off" : "isolate the bank"}`);
    let reserve: GroupView | null = null;
    if (role === "reserve") {
      if (isOn) issues.push("reserve switch is on: the bank is bridged to the grid instead of held back");
      const sides = [primary, secondary].filter((g): g is GroupView => !!g);
      const isolated = sides.filter((g) => !main || g.group !== main.group);
      // Sides joined (switch on, or bypassed): nothing is "behind" it. Otherwise the side that is not the grid,
      // preferring the one that actually has a battery, then the one with less generation.
      const score = (g: GroupView) => (g.batteryMWh > 0 ? 0 : 1e12) + g.capacityMW;
      reserve = sidesJoined ? null : isolated.length ? isolated.reduce((a, b) => (score(b) < score(a) ? b : a)) : null;
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
      if (!isOn) issues.push("tie is off: this site is cut off from the main grid");
      for (const [label, g] of [["primary", primary], ["secondary", secondary]] as const) if (g?.fuseTripped) issues.push(`fuse tripped on the ${label} side`);
    }
    // Normal operation: reserves off, ties on.
    const expectedOn = role === "tie";
    switches.push({
      id: String(s.ID), name, site: siteOf(name), role, isOn, sidesJoined, expectedOn, ok: issues.length === 0, issues, notes,
      primaryCircuit: pc, secondaryCircuit: sc, primary, secondary, reserve, location: loc(s),
    });
  }

  const siteNames = [...new Set(switches.map((s) => s.site))].sort();
  const sites: SiteRow[] = siteNames.map((site) => {
    const reserve = switches.find((s) => s.site === site && s.role === "reserve") ?? null;
    const tie = switches.find((s) => s.site === site && s.role === "tie") ?? null;
    const issues = [...(reserve?.issues ?? []), ...(tie?.issues ?? [])];
    const notes: string[] = [...(reserve?.notes ?? []), ...(tie?.notes ?? [])];
    if (!reserve) notes.push("no *-EMERGENCY-RESERVE switch for this site yet");
    if (!tie) notes.push("no *-TIE switch for this site yet");
    return { site, reserve, tie, ok: issues.length === 0, issues, notes };
  });

  const reserves = switches.filter((s) => s.role === "reserve"), ties = switches.filter((s) => s.role === "tie");
  // normal: every reserve off and every tie on. dark-restart: every reserve on and every tie off. Anything else is mixed.
  const mode: Mode = !switches.length ? "none"
    : reserves.every((s) => !s.isOn) && ties.every((s) => s.isOn) ? "normal"
    : reserves.length > 0 && reserves.every((s) => s.isOn) && ties.every((s) => !s.isOn) ? "dark-restart"
    : "mixed";
  // Ready = normal mode, every switch in its normal position, a full bank behind each reserve.
  const ready = mode === "normal" && reserves.length > 0 && switches.every((s) => s.ok);

  return { mode, ready, minChargePct, mainGroup: main?.group ?? null, sites, switches, otherSwitches };
}
