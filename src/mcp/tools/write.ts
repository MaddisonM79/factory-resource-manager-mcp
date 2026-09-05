// Writes, gated by FRM_ALLOW_WRITE.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, WRITE_ENDPOINTS, frmPost } from "../../frm/client.ts";

import { guard } from "../shared.ts";

export function registerWrite(server: McpServer, env: Env): void {
  server.registerTool(
    "set_enabled",
    {
      description:
        "Enable or disable buildings by ID (constructors, assemblers, manufacturers, generators, power switches). Requires FRM_ALLOW_WRITE=true.",
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).describe("building IDs from getFactory/getGenerators/getSwitches"),
        enabled: z.boolean(),
      }),
    },
    async ({ ids, enabled }) =>
      guard(() => frmPost(env, "setEnabled", ids.length === 1 ? { ID: ids[0], status: enabled } : ids.map((ID) => ({ ID, status: enabled })))),
  );

  server.registerTool(
    "frm_write",
    {
      description: "Raw POST to any FRM write endpoint with a JSON body. Check docs.ficsit.app for the body shape. Requires FRM_ALLOW_WRITE=true.",
      inputSchema: z.object({
        endpoint: z.enum(WRITE_ENDPOINTS),
        body: z.unknown().describe("JSON body"),
      }),
    },
    async ({ endpoint, body }) => guard(() => frmPost(env, endpoint, body)),
  );
}
