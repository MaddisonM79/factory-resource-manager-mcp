// FRM HTTP client + endpoint registry.
// Origin sits behind Cloudflare Access (service token). Writes additionally
// carry FRM's own API key if configured.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Snapshot } from "../history/history.ts";

export interface Env {
  FRM_BASE_URL: string;
  FRM_ALLOW_WRITE: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  FRM_API_KEY?: string;
  ADMIN_PASSPHRASE: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** history: raw 5-minute samples + hourly aggregates (see migrations/) */
  DB: D1Database;
  /** comma-separated hostnames the MCP handler accepts (DNS-rebinding guard) */
  MCP_HOSTS: string;
  /** the dashboard hostname; requests to it never touch the OAuth provider */
  DASH_HOST: string;
  /** Hanko project API, e.g. https://auth.example.com; its JWKS signs the session cookie */
  HANKO_API_URL: string;
  /** comma-separated emails allowed on the dashboard; a valid Hanko session for anyone else is a 403 */
  DASH_ALLOWED_EMAILS: string;
  /** static dashboard files (public/) */
  ASSETS: Fetcher;
}

export const READ_ENDPOINTS = [
  // Chat / session
  "getChatMessages", "getSessionInfo", "getPlayer", "getModList", "getResearchTrees",
  // Factory buildings
  "getFactory", "getAssembler", "getBlender", "getConstructor", "getConverter",
  "getEncoder", "getFoundry", "getManufacturer", "getPackager", "getParticle",
  "getRefinery", "getSmelter",
  // Factory infrastructure
  "getBelts", "getCables", "getElevators", "getExtractor", "getFrackingActivator",
  "getHUBTerminal", "getHyperEntrance", "getHyperJunctions", "getHypertube", "getLifts", "getPipes", "getPipeJunctions",
  "getPortal", "getPump", "getRadarTower", "getResourceSinkBuilding", "getSpaceElevator",
  "getSplitterMerger", "getSwitches", "getSPWN", "getThroughputCounter", "getTradingPost", "getTrainRails", "getTrainSignals",
  // Generators
  "getGenerators", "getBiomassGenerator", "getCoalGenerator", "getFuelGenerator",
  "getGeothermalGenerator", "getNuclearGenerator",
  // Inventory
  "getCloudInv", "getCrateInv", "getStorageInv", "getWorldInv",
  // Resource nodes
  "getResourceNode", "getResourceDeposit", "getResourceGeyser", "getResourceWell",
  // Sink
  "getResourceSink", "getExplorationSink", "getSinkList",
  // Stations / vehicles
  "getDroneStation", "getTrainStation", "getTruckStation",
  "getDrone", "getExplorer", "getFactoryCart", "getTractor", "getTrains", "getTruck",
  "getVehiclePaths", "getVehicles",
  // World
  "getArtifacts", "getBlueprints", "getCreatures", "getDoggo", "getDropPod", "getFallingGiftBundles", "getHazards",
  "getItemPickups", "getMapMarkers", "getPowerSlug", "getProdStats", "getRecipes", "getSchematics", "getSpawners",
  "getSporeFlowers", "getTapes", "getUnlockItems", "getUObjectCount",
  // getAll is registered by FRM 1.5 but retired: it answers with an error object, so it is left out here.
  // Power
  "getPower", "getPowerUsage",
] as const;

export const WRITE_ENDPOINTS = [
  "setEnabled", "setSwitches", "createPing", "sendChatMessage", "setModSetting",
] as const;

export type ReadEndpoint = (typeof READ_ENDPOINTS)[number];
export type WriteEndpoint = (typeof WRITE_ENDPOINTS)[number];

function accessHeaders(env: Env): Record<string, string> {
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    Accept: "application/json",
  };
}

export class FrmError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

// The origin is a dedicated server that is meant to run 24/7, so "unreachable" is never
// "the machine is asleep". The status tells which layer failed:
//   502          cloudflared answered but nothing listens on FRM's port: the server is down,
//                still loading the save, or the FRM mod did not load (SML/mod mismatch).
//   530 / 1033   the tunnel itself has no connection: cloudflared is stopped or the laptop is offline.
//   503 / 504    Cloudflare could not complete the request in time.
function unreachableHint(status: number): string {
  if (status === 502) return "cloudflared is up but FRM is not listening on its port. Is the dedicated server running with the save loaded and the FRM mod active?";
  if (status === 530) return "the tunnel has no connection. Is cloudflared running on the server (systemctl status cloudflared) and is the laptop online?";
  return "the request did not complete through the tunnel. Check the server and cloudflared.";
}

async function handle(res: Response, endpoint: string): Promise<unknown> {
  if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530)) {
    throw new FrmError(`FRM origin unreachable (${res.status}): ${unreachableHint(res.status)}`, res.status);
  }
  if (res.status === 403) {
    throw new FrmError("Cloudflare Access rejected the service token (403).", 403);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FrmError(`${endpoint} -> ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new FrmError(`${endpoint} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const why = e?.name === "TimeoutError" ? "timed out after 20s" : (e?.message ?? String(e));
    throw new FrmError(`FRM origin unreachable (${why}). Is the dedicated server online with cloudflared running, the save loaded, and the FRM web server started?`);
  }
}

export async function frmGet(env: Env, endpoint: ReadEndpoint): Promise<unknown> {
  const res = await doFetch(`${env.FRM_BASE_URL}/${endpoint}`, {
    headers: accessHeaders(env),
    signal: AbortSignal.timeout(20_000),
  });
  return handle(res, endpoint);
}

export async function frmPost(env: Env, endpoint: WriteEndpoint, body: unknown): Promise<unknown> {
  if (env.FRM_ALLOW_WRITE !== "true") {
    throw new FrmError("Write endpoints are disabled. Set FRM_ALLOW_WRITE=true on the Worker to enable.");
  }
  const headers: Record<string, string> = {
    ...accessHeaders(env),
    "Content-Type": "application/json",
  };
  // FRM reads its token from x-frm-authorization and compares it raw (no "Bearer"); Authorization is ignored.
  if (env.FRM_API_KEY) headers["X-FRM-Authorization"] = env.FRM_API_KEY;
  const res = await doFetch(`${env.FRM_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return handle(res, endpoint);
}

// ---- helpers for trimming FRM's very chatty payloads ----

export function asArray(data: unknown): any[] {
  return Array.isArray(data) ? data : data == null ? [] : [data];
}

/** Case-insensitive substring match against the JSON of an item. */
export function matches(item: unknown, needle?: string): boolean {
  if (!needle) return true;
  return JSON.stringify(item).toLowerCase().includes(needle.toLowerCase());
}

/** Keep only the listed top-level fields (dot paths supported one level deep). */
export function project(item: any, fields?: string[]): any {
  if (!fields || fields.length === 0 || item == null || typeof item !== "object") return item;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const [a, b] = f.split(".");
    if (b) {
      if (item[a] != null) out[f] = item[a][b];
    } else if (a in item) {
      out[a] = item[a];
    }
  }
  return out;
}

const MAX_CHARS = 60_000;

export function pack(payload: unknown): string {
  const s = JSON.stringify(payload, null, 1);
  if (s.length <= MAX_CHARS) return s;
  return s.slice(0, MAX_CHARS) + `\n…[truncated ${s.length - MAX_CHARS} chars — narrow with filter/fields/limit]`;
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export function loc(item: any): string {
  const l = item?.location ?? item?.Location;
  if (!l) return "";
  return `(${Math.round(num(l.x ?? l.X))}, ${Math.round(num(l.y ?? l.Y))}, ${Math.round(num(l.z ?? l.Z))})`;
}

// ---- geometry (FRM coordinates are Unreal units: 1 unit = 1 cm) ----

export type Pt = { x: number; y: number; z: number };

export function pt(o: any): Pt | null {
  const l = o?.location ?? o?.Location ?? o;
  if (!l || typeof l !== "object" || (l.x == null && l.X == null)) return null;
  return { x: num(l.x ?? l.X), y: num(l.y ?? l.Y), z: num(l.z ?? l.Z) };
}

export const fmtPt = (p: Pt) => `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;

export function inBox(p: Pt, bb: any, pad = 0): boolean {
  const mn = bb?.min, mx = bb?.max;
  if (!mn || !mx) return false;
  return (
    p.x >= num(mn.x) - pad && p.x <= num(mx.x) + pad &&
    p.y >= num(mn.y) - pad && p.y <= num(mx.y) + pad &&
    p.z >= num(mn.z) - pad && p.z <= num(mx.z) + pad
  );
}

export const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ---- sampler: periodic snapshots in KV so tools can report trends ----
// Written by the cron trigger (every 5 min) and by every trend tool call.

export interface PowerSample {
  g: number;
  /** member circuit IDs; more stable than the group number, which is renumbered on rewiring */
  ids: number[];
  cap: number; prod: number; cons: number; max: number;
  bcap: number; bpct: number; bin: number; bout: number; fuse: boolean;
}
export interface SinkSample { total: number; toCoupon: number; coupons: number; pct: number }
export interface SessionStamp { name: string; play: number }
export interface Sample {
  t: number;
  /** true when the origin was unreachable at sample time; no data fields are trusted */
  gap?: true;
  /** session name + total play seconds, so a save reload can be detected */
  session?: SessionStamp;
  power: PowerSample[];
  cloud: Record<string, number> | null;
  sink: SinkSample | null;
  xsink: SinkSample | null;
}

const RING_KEY = "samples:ring";
const RING_MAX_AGE_MS = 24 * 3600 * 1000;
const RING_MAX = 700;

const sinkOf = (s: any): SinkSample | null =>
  s ? { total: num(s.TotalPoints), toCoupon: num(s.PointsToCoupon), coupons: num(s.NumCoupon), pct: num(s.Percent) } : null;

/**
 * Fetch one snapshot of raw FRM payloads. getPower (and, when `full`, getSessionInfo) must
 * succeed or this throws (origin down); everything else is best-effort. `full` adds the
 * heavy endpoints the D1 sampler needs; trend tools use the light form.
 */
export async function fetchSnapshot(env: Env, full = false): Promise<Snapshot> {
  const opt = (e: ReadEndpoint) => frmGet(env, e).catch(() => null);
  const [power, cloud, sink, xsink, session] = await Promise.all([
    frmGet(env, "getPower"),
    opt("getCloudInv"),
    opt("getResourceSink"),
    opt("getExplorationSink"),
    full ? frmGet(env, "getSessionInfo") : opt("getSessionInfo"),
  ]);
  const snap: Snapshot = { t: Date.now(), power, cloud, sink, xsink, session };
  if (full) {
    const [factory, generators, prodStats, stations, trains, schematics, droneStations, counters] = await Promise.all([
      opt("getFactory"), opt("getGenerators"), opt("getProdStats"), opt("getTrainStation"), opt("getTrains"), opt("getSchematics"),
      opt("getDroneStation"), opt("getThroughputCounter"),
    ]);
    Object.assign(snap, { factory, generators, prodStats, stations, trains, schematics, droneStations, counters });
  }
  return snap;
}

/** The KV ring's view of a snapshot. */
export function toSample(snap: Snapshot): Sample {
  const cloudMap: Record<string, number> | null = snap.cloud
    ? Object.fromEntries(asArray(snap.cloud).map((i: any) => [String(i.Name), num(i.Amount)]))
    : null;
  const sess: any = asArray(snap.session)[0];
  return {
    t: snap.t,
    session: sess ? { name: String(sess.SessionName ?? ""), play: num(sess.TotalPlayDuration) } : undefined,
    power: asArray(snap.power).map((c: any) => ({
      g: num(c.CircuitGroupID ?? c.CircuitID),
      ids: asArray(c.AssociatedCircuits).map(num).sort((a, b) => a - b),
      cap: num(c.PowerCapacity), prod: num(c.PowerProduction), cons: num(c.PowerConsumed), max: num(c.PowerMaxConsumed),
      bcap: num(c.BatteryCapacity), bpct: num(c.BatteryPercent), bin: num(c.BatteryInput), bout: num(c.BatteryOutput),
      fuse: !!c.FuseTriggered,
    })),
    cloud: cloudMap,
    sink: sinkOf(asArray(snap.sink)[0]),
    xsink: sinkOf(asArray(snap.xsink)[0]),
  };
}

/** Fetch one sample. Throws if getPower fails (origin down); other parts are best-effort. */
export async function takeSample(env: Env): Promise<Sample> {
  return toSample(await fetchSnapshot(env));
}

/** A marker written when the origin was unreachable, so trends never span a downtime hole. */
export const gapSample = (): Sample => ({ t: Date.now(), gap: true, power: [], cloud: null, sink: null, xsink: null });

export async function readSamples(env: Env): Promise<Sample[]> {
  const raw = await env.OAUTH_KV.get(RING_KEY, "json").catch(() => null);
  return Array.isArray(raw) ? (raw as Sample[]) : [];
}

/** Append a sample to the ring (24 h / RING_MAX entries) and return the full ring. */
export async function appendSample(env: Env, s: Sample): Promise<Sample[]> {
  const cutoff = s.t - RING_MAX_AGE_MS;
  const ring = (await readSamples(env)).filter((x) => x.t >= cutoff);
  ring.push(s);
  while (ring.length > RING_MAX) ring.shift();
  await env.OAUTH_KV.put(RING_KEY, JSON.stringify(ring));
  return ring;
}

export type TrendCut = "gap" | "session-change" | "save-reload" | null;
export interface TrendWindow {
  /** usable samples, oldest first, ending with the newest */
  samples: Sample[];
  /** why history older than samples[0] was discarded, if it was */
  truncatedBy: TrendCut;
  truncatedAt: number | null;
}

/**
 * The usable history for a trend: the contiguous run of good samples ending at
 * the newest one, cut at any downtime gap, session-name change, or play-time
 * regression (an older save was loaded), then limited to the window.
 */
export function windowOf(ring: Sample[], minutes: number, now: number): TrendWindow {
  const sorted = [...ring].sort((a, b) => a.t - b.t);
  const cutoff = now - minutes * 60_000;
  const out: Sample[] = [];
  let truncatedBy: TrendCut = null, truncatedAt: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i], newer = out[0];
    let cut: TrendCut = null;
    if (s.gap) cut = "gap";
    else if (newer?.session && s.session) {
      if (s.session.name !== newer.session.name) cut = "session-change";
      else if (s.session.play > newer.session.play + 1) cut = "save-reload";
    }
    if (cut) { truncatedBy = cut; truncatedAt = s.t; break; }
    if (s.t < cutoff) break;
    out.unshift(s);
  }
  return { samples: out, truncatedBy, truncatedAt };
}

export const minutesBetween = (a: number, b: number) => Math.abs(b - a) / 60_000;
export const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
