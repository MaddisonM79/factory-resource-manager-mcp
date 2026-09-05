// The dashboard host. Static files from public/ plus the read API, gated by a Hanko
// session: the Hanko frontend SDK stores its JWT in a first-party `hanko` cookie, and
// this verifies it against the project's JWKS and an email allow-list. The MCP host
// and its OAuth flow never see any of this.

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import type { Env } from "./frm.ts";
import { api, apiError } from "./api.ts";

export const SESSION_COOKIE = "hanko";

export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export interface Viewer { sub: string; email: string }

/** Hanko puts the primary address in an `email` object claim; older tokens only carry `sub`. */
export function emailOf(payload: JWTPayload): string | null {
  const e = (payload as any).email;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.address === "string") return e.address;
  return null;
}

export const allowedEmails = (env: Pick<Env, "DASH_ALLOWED_EMAILS">): string[] =>
  env.DASH_ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Verify signature + expiry, then the allow-list. `getKey` is injectable so tests can use a local key set. */
export async function verifySession(token: string, getKey: JWTVerifyGetKey, allowed: string[]): Promise<Viewer> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey));
  } catch (e: any) {
    throw new Unauthorized(`invalid session: ${e?.code ?? e?.message ?? e}`);
  }
  const email = emailOf(payload);
  if (!email) throw new Forbidden("session token carries no email claim");
  if (!payload.sub) throw new Unauthorized("session token has no subject");
  if (!allowed.includes(email.toLowerCase())) throw new Forbidden(`${email} is not allowed here`);
  return { sub: payload.sub, email };
}

// One remote key set per isolate per Hanko URL; jose caches the keys and refetches on unknown kid.
const keySets = new Map<string, JWTVerifyGetKey>();
export function jwksFor(hankoApiUrl: string): JWTVerifyGetKey {
  let ks = keySets.get(hankoApiUrl);
  if (!ks) { ks = createRemoteJWKSet(new URL("/.well-known/jwks.json", hankoApiUrl)); keySets.set(hankoApiUrl, ks); }
  return ks;
}

export function tokenFrom(c: { req: { header(name: string): string | undefined; raw: Request } }): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return getCookie(c as any, SESSION_COOKIE) ?? null;
}

type Vars = { viewer: Viewer };

export const dash = new Hono<{ Bindings: Env; Variables: Vars }>();

dash.onError((e, c) => {
  if (e instanceof Unauthorized) return c.json({ error: e.message, login: true }, 401);
  if (e instanceof Forbidden) return c.json({ error: e.message }, 403);
  return apiError(e, c);
});

// Public: what the login page needs to boot the Hanko element.
dash.get("/config", (c) => c.json({ hanko_api: c.env.HANKO_API_URL }));

dash.use("/api/*", async (c, next) => {
  const token = tokenFrom(c);
  if (!token) throw new Unauthorized("no session");
  c.set("viewer", await verifySession(token, jwksFor(c.env.HANKO_API_URL), allowedEmails(c.env)));
  c.header("Cache-Control", "no-store");
  await next();
});

dash.get("/api/me", (c) => c.json(c.get("viewer")));

// Same routes as the OAuth-fronted /api/ on the MCP host.
dash.route("/", api);

// Everything else is a static file from public/ (index.html at /).
dash.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
