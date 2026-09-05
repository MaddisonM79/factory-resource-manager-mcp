// Escape hatch: any FRM read endpoint, trimmed with filter/fields/limit.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Env,
  READ_ENDPOINTS,
  frmGet,
  asArray,
  matches,
  project,
} from "../../frm/client.ts";

import { guard } from "../shared.ts";

export function registerRaw(server: McpServer, env: Env): void {
  server.registerTool(
    "frm_get",
    {
      description:
        "Call any Ficsit Remote Monitoring read endpoint. Use filter (substring across the item's JSON), " +
        "fields (comma-separated top-level keys to keep), and limit to keep responses small — getFactory/getBelts on a big base are enormous.",
      inputSchema: z.object({
        endpoint: z.enum(READ_ENDPOINTS),
        filter: z.string().optional().describe("case-insensitive substring; item kept if its JSON contains it"),
        fields: z.string().optional().describe("comma-separated keys to keep, e.g. 'Name,Recipe,Productivity,location'"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    },
    async ({ endpoint, filter, fields, limit, offset }) =>
      guard(async () => {
        const items = asArray(await frmGet(env, endpoint)).filter((i) => matches(i, filter));
        const f = fields?.split(",").map((s) => s.trim()).filter(Boolean);
        return {
          endpoint,
          total: items.length,
          returned: Math.min(limit, Math.max(0, items.length - offset)),
          items: items.slice(offset, offset + limit).map((i) => project(i, f)),
        };
      }),
  );
}
