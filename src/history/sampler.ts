// The 5-minute tick: KV ring as before, plus one D1 batch. State between ticks lives in KV
// so the sampler never reads D1.

import { type Env, fetchSnapshot, toSample, appendSample, gapSample } from "../frm/client.ts";
import { type HistoryState, type Snapshot, buildTick, gapState, initialState } from "./history.ts";
import { writeTick, writeGap, rollup } from "./store.ts";

const STATE_KEY = "history:state";

export async function readState(env: Env): Promise<HistoryState> {
  const raw = await env.OAUTH_KV.get(STATE_KEY, "json").catch(() => null) as Partial<HistoryState> | null;
  return raw && typeof raw === "object" ? { ...initialState(), ...raw } : initialState();
}

export const writeState = (env: Env, s: HistoryState) => env.OAUTH_KV.put(STATE_KEY, JSON.stringify(s));

export async function runTick(env: Env, now = Date.now()): Promise<void> {
  const state = await readState(env);
  const ts = Math.floor(now / 1000);
  let snap: Snapshot;
  try {
    snap = await fetchSnapshot(env, true);
  } catch (e: any) {
    const why = String(e?.message ?? e);
    console.warn("origin down, writing gap sample:", why);
    await appendSample(env, gapSample());
    // One gap row and nothing else this tick. Open visits and rate baselines are dropped.
    await writeGap(env.DB, state, ts, why);
    await writeState(env, gapState(state));
    return;
  }
  await appendSample(env, toSample(snap));
  const tick = buildTick(snap, state, ts);
  await writeTick(env.DB, tick);
  await writeState(env, tick.state);
}

/** Daily: raw -> hourly for everything older than 7 days, then drop the raw rows. */
export async function runRollup(env: Env, now = Date.now()): Promise<{ cutoff: number }> {
  return rollup(env.DB, Math.floor(now / 1000));
}
