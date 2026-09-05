# frm-mcp

Cloudflare Worker exposing Ficsit Remote Monitoring (Satisfactory) as a remote
MCP server for claude.ai. Origin: `https://frm.lmam.tech` (cloudflared tunnel
on the Shadow box). Deployed at `https://frm-mcp.lmam.tech/mcp`.

Stateless: `createMcpHandler` from `agents/mcp/server` builds a fresh
`McpServer` (MCP SDK v2) per request. No Durable Object. OAuth is
`@cloudflare/workers-oauth-provider` with a single passphrase approval page and
tokens in KV.

## Tools

| tool | what |
|---|---|
| `frm_get` | any of ~75 read endpoints, with `filter` / `fields` / `limit` / `offset` |
| `power_overview` | per-circuit capacity, draw, headroom, batteries, fuses |
| `factory_problems` | idle / paused / low-efficiency machines grouped by building+recipe |
| `production_balance` | item production vs consumption, deficits first |
| `find_item` | which containers hold an item, how much, where |
| `logistics_status` | trains (with rolled-up cargo), stations (per-platform), trucks, drones |
| `session_status` | session info, players, UObject count |
| `site_status` | one row per site (spatial cluster, default 200 m): machines by state, MW, buildings, recipes |
| `belt_load` | belts by tier, dangling ends, belts too slow for the machine they feed/drain; bbox filter |
| `station_throughput` | per train station + platform: mode, status, cargo, rates, trains scheduled / inbound / docked |
| `sink_rates` | AWESOME sink coupons, points/min, ETA to coupon, sink buildings, item point values |
| `depot_status` | Dimensional Depot per item: stock, capacity, full, fill rate, minutes to full, when it filled |
| `battery_trend` | battery % and power deltas per circuit over a window, from the sampler history |
| `set_enabled` | toggle buildings by ID (gated) |
| `frm_write` | raw POST to any write endpoint (gated) |

The trend tools (`sink_rates`, `depot_status`, `battery_trend`) read a sample
ring in KV (`samples:ring`, 24 h). A cron trigger samples `getPower`,
`getCloudInv`, and both sinks every 5 minutes; every trend call adds a sample
too. A second cron purges expired OAuth data daily.

FRM limits worth knowing: belt `ItemsPerMinute` is the tier cap, not live
flow, so `belt_load` infers problems from connected machines. No per-building
sink rate, no train dwell history, no depot upload rate (derived from samples).

Writes are off unless `FRM_ALLOW_WRITE=true`. FRM's own write auth uses
`FRM_API_KEY` if you set one in FRM's config.

## Deploy

Account is pinned to LMAM in `wrangler.jsonc`; KV namespace `frm-mcp-OAUTH_KV`
is already bound.

```bash
npm install
npm run typecheck
op read 'op://Private/cloudflared-shadow-frm/client id'     | npx wrangler secret put CF_ACCESS_CLIENT_ID
op read 'op://Private/cloudflared-shadow-frm/client secret' | npx wrangler secret put CF_ACCESS_CLIENT_SECRET
op read 'op://Private/frm-mcp-passphrase/password'          | npx wrangler secret put ADMIN_PASSPHRASE
npx wrangler deploy
```

## Connect in claude.ai

Settings → Connectors → Add custom connector → URL `https://frm-mcp.lmam.tech/mcp`.
It redirects to `/authorize`, asks for the passphrase (1Password item
`frm-mcp-passphrase`), done. No client id/secret needed — dynamic client
registration handles it.

## Smoke test without claude.ai

```bash
curl https://frm-mcp.lmam.tech/.well-known/oauth-authorization-server
```

Or `npx @modelcontextprotocol/inspector` against `https://frm-mcp.lmam.tech/mcp`.

## Notes

- FRM only serves once a save is loaded. Set `Web_Autostart: true` in
  `FactoryGame/Configs/FicsitRemoteMonitoring/WebServer.cfg` on the Shadow box
  or you'll be typing `/frm http start` forever.
- Shadow sleeps → tunnel dies → tools return a clear "origin unreachable" error
  (covers fetch failures, timeouts, and Cloudflare 5xx from the tunnel).
- Verified FRM field names (Sept 2026): `getFactory` items carry `Productivity`,
  `IsProducing`, `IsPaused`, `IsConfigured`, lowercase `ingredients` /
  `production` / `location`. `getProdStats` uses `CurrentProd` / `CurrentConsumed`
  / `MaxProd` / `MaxConsumed`. `getStorageInv` uses `Inventory[]`.
  `getTrainStation.CargoInventory[]` is a list of freight platforms, each with
  its own `Inventory`, `LoadingMode`, `LoadingStatus`, `DockingStatus`.
  If a curated tool looks empty, hit `frm_get` on the raw endpoint with
  `limit: 1` and check the keys.
