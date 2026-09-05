// The OAuth provider's default handler: the passphrase approval page and a root banner.
// /authorize, /token, /register and / fall through here; /mcp and /api/ do not.

import { Hono } from "hono";
import type { Env } from "../frm/client.ts";

type Props = { user: string };

export const app = new Hono<{ Bindings: Env }>();

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>frm-mcp</title>
<style>body{font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 1rem;color:#eee;background:#111}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem;border-radius:6px;border:1px solid #444;background:#1b1b1b;color:#eee}
button{background:#f60;border:0;color:#000;font-weight:600;cursor:pointer}</style></head><body>${body}</body></html>`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

app.get("/", (c) => c.text("frm-mcp: MCP endpoint at /mcp (Streamable HTTP)"));

app.get("/authorize", async (c) => {
  const oauth = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const state = btoa(JSON.stringify(oauth));
  return c.html(
    page(`<h2>frm-mcp</h2><p>Authorize <b>${esc(oauth.clientId)}</b> to read your factory?</p>
<form method="post" action="/authorize">
<input type="hidden" name="state" value="${esc(state)}">
<input type="password" name="passphrase" placeholder="passphrase" autofocus>
<button type="submit">Approve</button></form>`),
  );
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const passphrase = String(form.get("passphrase") ?? "");
  const state = String(form.get("state") ?? "");
  if (!state) return c.text("missing state", 400);

  const enc = new TextEncoder();
  const a = enc.encode(passphrase);
  const b = enc.encode(c.env.ADMIN_PASSPHRASE);
  const ok = a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
  if (!ok) return c.html(page("<h2>Nope.</h2><p><a href='javascript:history.back()'>Try again</a></p>"), 401);

  const oauth = JSON.parse(atob(state));
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth,
    userId: "owner",
    metadata: { label: "frm-mcp" },
    scope: oauth.scope,
    props: { user: "owner" } satisfies Props,
  });
  return Response.redirect(redirectTo, 302);
});
