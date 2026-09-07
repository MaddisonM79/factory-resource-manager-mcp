// MCP server factory. Stateless: a fresh McpServer per request, no Durable Object.
// Tools close over env and live in tools/, one module per family.

import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../frm/client.ts";
import { SERVER_VERSION } from "../version.ts";
import { registerRaw } from "./tools/raw.ts";
import { registerPower } from "./tools/power.ts";
import { registerFactory } from "./tools/factory.ts";
import { registerLogistics } from "./tools/logistics.ts";
import { registerSinkDepot } from "./tools/sink-depot.ts";
import { registerTrend } from "./tools/trend.ts";
import { registerWrite } from "./tools/write.ts";

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "frm", version: SERVER_VERSION });
  registerRaw(server, env);
  registerPower(server, env);
  registerFactory(server, env);
  registerLogistics(server, env);
  registerSinkDepot(server, env);
  registerTrend(server, env);
  registerWrite(server, env);
  return server;
}
