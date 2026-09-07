// The OAuth provider instance, shared by the Worker entry (which routes the MCP host through it)
// and the admin API (which lists and revokes clients and grants on the dashboard host).

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../frm/client.ts";
import { buildServer } from "./server.ts";
import { app } from "./oauth.ts";
import { api } from "../api/routes.ts";

type Props = { user: string };

const mcp = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const handler = createMcpHandler(() => buildServer(env), {
      route: "/mcp",
      allowedHostnames: [...env.MCP_HOSTS.split(",").map((h) => h.trim()).filter(Boolean), "localhost", "127.0.0.1"],
      authContext: { props: ((ctx as any).props as Props | undefined) ?? {} },
      onerror: (e) => console.error("mcp:", e),
    });
    return handler(request, env, ctx);
  },
};

// /api/* shares the bearer check with /mcp: the provider validates the token before either handler runs.
const historyApi = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => api.fetch(request, env, ctx),
};

export const provider = new OAuthProvider({
  apiHandlers: { "/mcp": mcp, "/api/": historyApi },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

/**
 * The helpers the provider hands to handlers as env.OAUTH_PROVIDER, built for a request that did
 * not go through the provider (the dashboard host). createOAuthHelpers is public in the library's
 * JS but absent from its typings.
 */
export const oauthHelpers = (env: Env) => (provider as any).createOAuthHelpers(env) as Env["OAUTH_PROVIDER"];
