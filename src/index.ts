// Worker entry. One Worker, two hostnames: the MCP server and its OAuth flow on MCP_HOSTS
// (src/mcp/provider.ts), the dashboard on DASH_HOST. Cron: sampler every 5 min, OAuth purge +
// history rollup daily.

import type { Env } from "./frm/client.ts";
import { provider } from "./mcp/provider.ts";
import { dash } from "./web/app.ts";
import { runTick, runRollup } from "./history/sampler.ts";

export default {
  // The dashboard host is a separate app: Hanko session cookie, static assets, the same read API.
  // Every other host (the MCP host, and the old one until it is removed) goes through the OAuth provider.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    new URL(request.url).hostname === env.DASH_HOST ? dash.fetch(request, env, ctx) : provider.fetch(request, env, ctx),
  // */5: sample into the KV ring and D1 (one batch). Daily: purge expired OAuth data, then roll up history.
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      (async () => {
        if (event.cron.startsWith("*/5")) {
          await runTick(env);
        } else {
          const r = await provider.purgeExpiredData(env);
          console.log("oauth purge:", JSON.stringify(r));
          const { cutoff } = await runRollup(env);
          console.log("history rollup: raw samples before", new Date(cutoff * 1000).toISOString(), "rolled to hourly");
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
