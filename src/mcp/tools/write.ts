// Writes, gated by FRM_ALLOW_WRITE.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, WRITE_ENDPOINTS, frmPost } from "../../frm/client.ts";

import { guard } from "../shared.ts";

/**
 * FRM only accepts a JSON object or array. MCP clients often hand the body over as a string,
 * which stringified again would reach FRM as a quoted string and be refused as an invalid body.
 */
export function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("body is a string but not valid JSON"); }
  if (parsed === null || typeof parsed !== "object") throw new Error("body must be a JSON object or an array of objects");
  return parsed;
}

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
      description:
        "Raw POST to any FRM write endpoint. body is an object or an array of objects (FRM treats a single object as a one-item array); " +
        "a JSON string is parsed first. Shapes: sendChatMessage [{sender?, message, color?}], setEnabled [{ID, status}], " +
        "setSwitches [{ID, status?, priority?, name?}], createPing [{x, y, z}], setModSetting [{setting, value}]. Requires FRM_ALLOW_WRITE=true.",
      inputSchema: z.object({
        endpoint: z.enum(WRITE_ENDPOINTS),
        body: z.unknown().describe("object, array of objects, or a JSON string of either"),
      }),
    },
    async ({ endpoint, body }) => guard(() => frmPost(env, endpoint, parseBody(body))),
  );
}
