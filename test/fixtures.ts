// Small FRM-shaped payloads.
import type { Snapshot } from "../src/history/history.ts";

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

// Shape as returned by FRM on a live save: FuelAmount is a number, CanStart flips off when dry,
// AvailableFuel lists accepted fuel types (never stock).
export const generator = (x: number, y: number, cls = "Build_GeneratorCoal_C", fuel = 10) => ({
  Name: "Coal-Powered Generator", ClassName: cls, location: { x, y, z: 0 }, ProductionCapacity: 75, BaseProd: 75,
  FuelAmount: fuel, CanStart: fuel > 0, IsFullSpeed: true, LoadPercentage: fuel > 0 ? 100 : 0, FuelInventory: [],
  AvailableFuel: [{ Name: "Coal", ClassName: "Desc_Coal_C", Amount: 300 }, { Name: "Compacted Coal", ClassName: "Desc_CompactedCoal_C", Amount: 630 }],
});

export const nuclear = (x: number, y: number, waste = 0, warning = "None") => ({
  ...generator(x, y, "Build_GeneratorNuclear_C", 1), Name: "Nuclear Power Plant", ProductionCapacity: 2500, BaseProd: 2500, LoadPercentage: 60,
  WasteInventory: waste ? [{ Name: "Uranium Waste", ClassName: "Desc_NuclearWaste_C", Amount: waste }] : [], NuclearWarning: warning,
  Supplement: { Name: "Water", ClassName: "Desc_Water_C", CurrentConsumed: 240, MaxConsumed: 240, PercentFull: 100 },
});

// Shape as returned by FRM 1.5 getDroneStation: item rates are per minute, round trips are seconds
// (LatestRndTrip) or a time string (AvgRndTrip, MedianRndTrip), pairing is "None" when unpaired.
export const dronePort = (name: string, paired: string | null, o: Partial<{ inRate: number; outRate: number; status: string; fuel: number; trip: number }> = {}) => ({
  ID: `DP-${name}`, Name: name, ClassName: "Build_DroneStation_C", location: { x: 0, y: 0, z: 0 },
  PairedStation: paired ?? "None", DroneStatus: o.status ?? "En Route",
  AvgIncRate: o.inRate ?? 0, AvgOutRate: o.outRate ?? 0, AvgTotalIncRate: o.inRate ?? 0, AvgTotalOutRate: o.outRate ?? 0, EstTotalTransRate: (o.inRate ?? 0) + (o.outRate ?? 0),
  AvgRndTrip: "00:03:20", MedianRndTrip: "00:03:18", LatestRndTrip: o.trip ?? 200,
  AvgTripIncAmt: 300, AvgTripOutAmt: 0, MedianTripIncAmt: 300, MedianTripOutAmt: 0, LatestTripIncAmt: 290, LatestTripOutAmt: 0,
  ActiveFuel: { FuelName: "Battery", SingleTripFuelCost: 1.25, EstimatedTransportRate: 90, EstimatedRoundTripTime: 200, EstimatedFuelCostRate: 0.375 },
  FuelInfo: [{ FuelName: "Battery", SingleTripFuelCost: 1.25, EstimatedTransportRate: 90, EstimatedRoundTripTime: 200, EstimatedFuelCostRate: 0.375 }],
  FuelInventory: [{ Name: "Battery", Amount: o.fuel ?? 40, MaxAmount: 200 }],
  InputInventory: [{ Name: "Quickwire", Amount: 500, MaxAmount: 500 }], OutputInventory: [],
  PowerInfo: { CircuitGroupID: 1, FuseTriggered: false, PowerConsumed: 100, MaxPowerConsumed: 100 },
});

// getThroughputCounter: a conveyor monitor sitting on a belt. Belt carries the class and tier cap, not the belt ID.
export const counter = (id: string, x: number, y: number, avg: number, o: Partial<{ cap: number; confidence: number; cls: string }> = {}) => ({
  ID: id, Name: "Throughput Counter", ClassName: "Build_ConveyorMonitor_C", location: { x, y, z: 0 },
  Belt: { Name: "Conveyor Belt Mk.3", ClassName: o.cls ?? "Build_ConveyorBeltMk3_C", ItemsPerMinute: o.cap ?? 270 },
  CalculatedAverage: avg, Confidence: o.confidence ?? 100, TimePerAverageSection: 60, MaxTotalAverageDuration: 600,
});

export const signal = (id: string, aspect: string, block = "Valid", cls = "Build_RailroadBlockSignal_C") => ({
  ID: id, Name: "Block Signal", ClassName: cls, location: { x: 1, y: 2, z: 3 }, Aspect: aspect, BlockValid: block,
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
    // null here means "FRM has no such endpoint", so only undefined takes the default.
    droneStations: o.droneStations !== undefined ? o.droneStations : [dronePort("QW-OUT", "QW-IN", { outRate: 90, status: "Loading" }), dronePort("QW-IN", "QW-OUT", { inRate: 90 })],
    counters: o.counters !== undefined ? o.counters : [counter("CM-1", 0, 0, 240)],
  };
}
