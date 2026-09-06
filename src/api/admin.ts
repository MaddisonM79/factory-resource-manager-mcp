// Admin API: the stack's own health and the read-only game admin views. Mounted on the dashboard
// host only (Hanko session + allow-list); never behind the OAuth bearer, since a connector token
// must not be able to list or revoke other connectors.

import { Hono } from "hono";
import { type Env, frmGet, asArray, num, loc, readSamples } from "../frm/client.ts";
import { readState, readRollupMark } from "../history/sampler.ts";
import { RAW_RETENTION_SECONDS } from "../history/history.ts";
import { tableStats, epochs, recentGaps, rollupStatus } from "../history/store.ts";
import { SERVER_VERSION } from "../version.ts";

// The provider module pulls in the OAuth library and the MCP handler, which only load inside
// Workers; importing it lazily keeps this module (and the dashboard app) loadable under Node for tests.
const oauthHelpers = async (env: Env) => (await import("../mcp/provider.ts")).oauthHelpers(env);
import { BadRequest, apiError } from "./routes.ts";

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- oauth shaping (pure, tested)

export interface ClientRow { clientId: string; clientName: string | null; redirectUris: string[]; registrationDate: number | null; authMethod: string | null; grants: number }
export interface GrantRow { id: string; userId: string; clientId: string; clientName: string | null; scope: string[]; createdAt: number; expiresAt: number | null; label: string | null; tokens: number; latestTokenExpiry: number | null }
export interface TokenRow { userId: string; grantId: string; expiresAt: number | null }

/** Clients with their grant counts, grants with their live token counts. Inputs are the KV records as stored. */
export function summarizeOAuth(clients: any[], grants: any[], tokens: TokenRow[]): { clients: ClientRow[]; grants: GrantRow[] } {
  const byClient = new Map<string, any>(clients.map((c) => [String(c.clientId), c]));
  const grantRows: GrantRow[] = grants.map((g) => {
    const mine = tokens.filter((t) => t.userId === g.userId && t.grantId === g.id);
    return {
      id: String(g.id), userId: String(g.userId), clientId: String(g.clientId),
      clientName: byClient.get(String(g.clientId))?.clientName ?? null,
      scope: asArray(g.scope).map(String), createdAt: num(g.createdAt), expiresAt: g.expiresAt ?? null,
      label: g.metadata?.label ?? null,
      tokens: mine.length, latestTokenExpiry: mine.length ? Math.max(...mine.map((t) => num(t.expiresAt))) : null,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  const clientRows: ClientRow[] = clients.map((c) => ({
    clientId: String(c.clientId), clientName: c.clientName ?? null, redirectUris: asArray(c.redirectUris).map(String),
    registrationDate: c.registrationDate ?? null, authMethod: c.tokenEndpointAuthMethod ?? null,
    grants: grantRows.filter((g) => g.clientId === String(c.clientId)).length,
  })).sort((a, b) => (b.registrationDate ?? 0) - (a.registrationDate ?? 0));
  return { clients: clientRows, grants: grantRows };
}

/** Every value under a KV prefix, JSON-decoded, capped so a runaway namespace cannot hang the page. */
async function kvPrefix(kv: KVNamespace, prefix: string, cap = 500): Promise<{ key: string; value: any }[]> {
  const out: { key: string; value: any }[] = [];
  let cursor: string | undefined;
  while (out.length < cap) {
    const page = await kv.list({ prefix, cursor, limit: 100 });
    const vals = await Promise.all(page.keys.map(async (k) => ({ key: k.name, value: await kv.get(k.name, "json").catch(() => null) })));
    out.push(...vals.filter((v) => v.value != null));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

// ---------------------------------------------------------------- routes

export const admin = new Hono<{ Bindings: Env }>();
admin.onError(apiError);

/** Static configuration and gates: what this Worker is pointed at and what it is allowed to do. */
admin.get("/api/admin/system", (c) => c.json({
  now: now(),
  server_version: SERVER_VERSION,
  config: {
    frm_base_url: c.env.FRM_BASE_URL,
    mcp_hosts: c.env.MCP_HOSTS.split(",").map((h) => h.trim()).filter(Boolean),
    dash_host: c.env.DASH_HOST,
    hanko_api_url: c.env.HANKO_API_URL,
    allowed_emails: c.env.DASH_ALLOWED_EMAILS.split(",").map((s) => s.trim()).filter(Boolean),
    write_enabled: c.env.FRM_ALLOW_WRITE === "true",
    api_key_set: !!c.env.FRM_API_KEY,
    access_token_set: !!(c.env.CF_ACCESS_CLIENT_ID && c.env.CF_ACCESS_CLIENT_SECRET),
  },
  retention: { raw_seconds: RAW_RETENTION_SECONDS, ring_hours: 24 },
}));

/** Live reachability through Access and the tunnel, with latency, plus the FRM build and mod list. */
admin.get("/api/admin/origin", async (c) => {
  const t0 = Date.now();
  let session: any = null, error: string | null = null, status: number | null = null;
  try { session = asArray(await frmGet(c.env, "getSessionInfo"))[0] ?? null; }
  catch (e: any) { error = String(e?.message ?? e); status = e?.status ?? null; }
  const latency = Date.now() - t0;
  const mods = error ? [] : asArray(await frmGet(c.env, "getModList").catch(() => [])).map((m) => ({
    name: m.Name, smr: m.SMRName, version: m.Version, author: m.CreatedBy, requiredOnRemote: !!m.RequiredOnRemote,
  }));
  const frm = mods.find((m) => /FicsitRemoteMonitoring/i.test(String(m.smr ?? m.name)));
  return c.json({
    now: now(), reachable: error == null, latency_ms: latency, status, error,
    session: session && { name: session.SessionName, paused: !!session.IsPaused, play_text: session.TotalPlayDurationText, days: session.PassedDays },
    frm: { version: frm?.version ?? null, mods },
  });
});

/** Sampler state, the KV ring, D1 table sizes, epochs, recent gaps, and whether the rollup is keeping up. */
admin.get("/api/admin/sampler", async (c) => {
  const n = now();
  const [state, mark, ring, tables, ep, gaps, roll] = await Promise.all([
    readState(c.env), readRollupMark(c.env), readSamples(c.env), tableStats(c.env.DB), epochs(c.env.DB), recentGaps(c.env.DB), rollupStatus(c.env.DB, n),
  ]);
  const latest = ring[ring.length - 1] ?? null;
  return c.json({
    now: n,
    state: { ...state, visits: Object.keys(state.visits).length },
    ring: {
      size: ring.length, oldest: ring.length ? Math.floor(ring[0].t / 1000) : null, newest: latest ? Math.floor(latest.t / 1000) : null,
      staleness_seconds: latest ? n - Math.floor(latest.t / 1000) : null, gaps: ring.filter((s) => s.gap).length, latest_is_gap: !!latest?.gap,
    },
    rollup: { last_run: mark, ...roll },
    tables, epochs: ep, gaps,
  });
});

/** OAuth clients, grants and live tokens across every user id the provider has seen. */
admin.get("/api/admin/oauth", async (c) => {
  const kv = c.env.OAUTH_KV;
  const [clients, grants, tokens] = await Promise.all([kvPrefix(kv, "client:"), kvPrefix(kv, "grant:"), kvPrefix(kv, "token:")]);
  const tokenRows: TokenRow[] = tokens.map((t) => ({ userId: String(t.value.userId), grantId: String(t.value.grantId), expiresAt: t.value.expiresAt ?? null }));
  return c.json({ now: now(), ...summarizeOAuth(clients.map((x) => x.value), grants.map((x) => x.value), tokenRows), tokens: tokenRows.length });
});

admin.delete("/api/admin/oauth/grants/:userId/:grantId", async (c) => {
  const { userId, grantId } = c.req.param();
  if (!userId || !grantId) throw new BadRequest("userId and grantId");
  await (await oauthHelpers(c.env)).revokeGrant(grantId, userId);
  return c.json({ revoked: { userId, grantId } });
});

admin.delete("/api/admin/oauth/clients/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  if (!clientId) throw new BadRequest("clientId");
  await (await oauthHelpers(c.env)).deleteClient(clientId);
  return c.json({ deleted: clientId });
});

/** Read-only game administration: session, players, switches, chat, object pool. Each part is best-effort. */
admin.get("/api/admin/game", async (c) => {
  const errors: Record<string, string> = {};
  const opt = async (e: Parameters<typeof frmGet>[1]) => { try { return await frmGet(c.env, e); } catch (err: any) { errors[e] = String(err?.message ?? err); return null; } };
  const [session, players, switches, chat, uobj] = await Promise.all([opt("getSessionInfo"), opt("getPlayer"), opt("getSwitches"), opt("getChatMessages"), opt("getUObjectCount")]);
  const u: any = asArray(uobj)[0];
  const limit = Math.min(500, Math.max(1, Number(c.req.query("chat") ?? 50)));
  return c.json({
    now: now(),
    session: asArray(session)[0] ?? null,
    players: asArray(players).map((p) => ({ name: p.Name ?? p.PlayerName, id: p.PlayerID ?? null, online: !!p.Online, dead: !!p.Dead, health: num(p.PlayerHP), location: loc(p) })),
    switches: asArray(switches).map((s) => ({ id: s.ID, name: s.Name ?? s.SwitchTag ?? "", isOn: !!s.IsOn, priority: s.Priority ?? null, primary: s.Primary ?? null, secondary: s.Secondary ?? null, location: loc(s) })),
    chat: asArray(chat).slice(-limit).map((m) => ({ sender: m.Sender, message: m.Message, type: m.Type, time: m.ServerTimeStamp ?? m.TimeStamp ?? null })),
    uobjects: u ? { count: num(u.UObjectCount), capacity: num(u.UObjectCapacity) } : null,
    errors,
  });
});
