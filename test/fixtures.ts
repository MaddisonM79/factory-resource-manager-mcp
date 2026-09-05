// Small FRM-shaped payloads.
import type { Snapshot } from "../src/history.ts";

export const M = 100; // 1 m in map units

export const session = (name = "Save A", play = 1000) => [{ SessionName: name, TotalPlayDuration: play }];

export const power = (g = 1, pct = 50, fuse = false) => [{
  CircuitGroupID: g, AssociatedCircuits: [g, g + 10], PowerCapacity: 1000, PowerProduction: 600, PowerConsumed: 550, PowerMaxConsumed: 700,
  BatteryCapacity: 100, BatteryPercent: pct, BatteryInput: 10, BatteryOutput: 0, FuseTriggered: fuse,
}];

export const machine = (x: number, y: number, o: Partial<{ IsProducing: boolean; IsPaused: boolean; out: number; ingr: number }> = {}) => ({
  Name: "Smelter", Recipe: "Iron Ingot", location: { x, y, z: 0 }, Productivity: o.IsProducing === false ? 0 : 100,
  IsProducing: o.IsProducing ?? true, IsPaused: o.IsPaused ?? false, IsConfigured: true,
  PowerInfo: { CircuitGroupID: 1, PowerConsumed: 4, MaxPowerConsumed: 4, FuseTriggered: false },
  OutputInventory: [{ Name: "Iron Ingot", Amount: o.out ?? 0, MaxAmount: 100 }],
  InputInventory: [{ Name: "Iron Ore", Amount: o.ingr ?? 50 }],
  ingredients: [{ Name: "Iron Ore" }],
});

export const generator = (x: number, y: number, cls = "Build_GeneratorCoal_C", fuel = 10) => ({
  Name: "Coal-Powered Generator", ClassName: cls, location: { x, y, z: 0 }, ProductionCapacity: 75, IsProducing: fuel > 0,
  FuelInventory: [{ Name: "Coal", Amount: fuel }],
});

export const cloud = (amount = 50) => [{ Name: "Iron Plate", Amount: amount, MaxAmount: 100 }];
export const prodStats = () => [{ Name: "Iron Plate", CurrentProd: 60, CurrentConsumed: 30, MaxProd: 120, MaxConsumed: 30 }];
export const sink = (total: number) => [{ TotalPoints: total, PointsToCoupon: 1000, NumCoupon: 3, Percent: 0.4 }];

export const station = (name: string, cargo = 100) => ({
  Name: name, location: { x: 0, y: 0, z: 0 }, TransferRate: 1.5,
  CargoInventory: [{ LoadingMode: "Loading", TransferRate: 1.5, Inventory: [{ Name: "Iron Plate", Amount: cargo }] }],
});
export const train = (name: string, at: string, docked: boolean) => ({ Name: name, TrainStation: at, Docking: docked ? "TDS_Docked" : "TDS_None" });

export function snapshot(o: Partial<Snapshot> & { name?: string; play?: number } = {}): Snapshot {
  return {
    t: o.t ?? 1_700_000_000_000,
    power: o.power ?? power(),
    session: o.session ?? session(o.name, o.play),
    cloud: o.cloud ?? cloud(),
    sink: o.sink ?? sink(10_000),
    xsink: o.xsink ?? null,
    factory: o.factory ?? [machine(0, 0), machine(50 * M, 0), machine(5000 * M, 5000 * M, { IsProducing: false, out: 100 })],
    generators: o.generators ?? [generator(0, 0), generator(20 * M, 0), generator(8000 * M, 0, "Build_GeneratorFuel_C", 0)],
    prodStats: o.prodStats ?? prodStats(),
    stations: o.stations ?? [station("Iron Out")],
    trains: o.trains ?? [],
    schematics: o.schematics ?? null,
  };
}
