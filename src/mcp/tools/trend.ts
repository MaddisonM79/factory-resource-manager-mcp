// Historical series from D1, the same data as GET /api/series/*.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env } from "../../frm/client.ts";
import { cluster } from "../../history/history.ts";
import { querySeries } from "../../api/routes.ts";
import { thinSeries } from "../../history/store.ts";

import { guard } from "../shared.ts";

export function registerTrend(server: McpServer, env: Env): void {
  server.registerTool(
    "trend",
    {
      description:
        "Historical series from D1 (the same data as GET /api/series/*): power per circuit group, a site's machine states (by lookup id, or 'all' for every cluster), " +
        "generator fields (field id, 'all', or omit for map-wide; includes load % and nuclear waste), depot stock per item, item production/consumption, a train station's platforms, sink progress, " +
        "a drone port's rates and round trips (station name, or 'all'), or a throughput counter's measured items/min (FRM counter ID, or 'all'). " +
        "from/to are unix seconds; res defaults to raw 5-minute samples for windows of ≤ 7 days and hourly aggregates beyond. " +
        "One series per epoch when the window spans a session change or save reload; gaps list outages, which are never interpolated across.",
      inputSchema: z.object({
        series: z.enum(["power", "site", "gens", "depot", "prod", "station", "sinks", "drone", "counter"]),
        key: z.string().optional().describe("site id, field id, item name, station name, drone port name, counter id, or circuit group; 'all' for every site/field cluster, drone port, or counter"),
        from: z.number().int().optional().describe("unix seconds; default 24 h before `to`"),
        to: z.number().int().optional().describe("unix seconds; default now"),
        res: z.enum(["raw", "hourly"]).optional(),
        max_points: z.number().int().min(10).max(5000).default(600).describe("thin evenly to at most this many points per series"),
      }),
    },
    async ({ series, key, from, to, res, max_points }) =>
      guard(async () => {
        const now = Math.floor(Date.now() / 1000);
        const t = to ?? now, f = from ?? t - 24 * 3600;
        if (f > t) throw new Error("from must be <= to");
        const out = await querySeries(env, { kind: series, key, from: f, to: t, res }, now);
        // Per series key (circuit group, site, field, item, platform, sink): thinning the flat list drops whole keys.
        const thin = (s: Parameters<typeof thinSeries>[1]) => thinSeries(series, s, max_points);
        return Array.isArray(out) ? out.map(thin) : thin(out);
      }),
  );
}
