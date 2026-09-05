# factory-resource-manager-mcp

A remote [MCP](https://modelcontextprotocol.io) server for
[Satisfactory](https://www.satisfactorygame.com/) that lets Claude (or any MCP
client) query a running factory through the
[Ficsit Remote Monitoring](https://ficsit.app/mod/FicsitRemoteMonitoring) mod.

Ask "what's asleep?", "why is caterium short?", "which depot filled first?",
"is the battery draining?" and get answers computed from live game data.

It runs as a single Cloudflare Worker: stateless MCP over Streamable HTTP,
OAuth in front of it so claude.ai can add it as a custom connector, and a
cron sampler so a few tools can report trends instead of snapshots.

## How it fits together

```
claude.ai / Claude Desktop
        │  OAuth bearer token
        ▼
Cloudflare Worker  (frm-mcp)             ← this repo
  ├─ /authorize /token /register          workers-oauth-provider, KV-backed
  ├─ /mcp                                 createMcpHandler + MCP SDK v2
  └─ cron */5                             samples power/depot/sink into KV
        │  CF-Access service token
        ▼
Cloudflare Access  →  cloudflared tunnel  →  FRM web server (localhost:8080)
                                              on the machine running the game
```

The Worker never talks to the game directly. It calls FRM's JSON endpoints
through a Cloudflare Tunnel that is protected by a Cloudflare Access
service-auth policy. Nothing on the game machine is exposed to the internet.

## Tools

| tool | what it answers |
|---|---|
| `session_status` | Is the game up? Session info, players, UObject count |
| `power_overview` | Per circuit: capacity, draw, headroom, battery, tripped fuses |
| `factory_problems` | Idle / paused / low-efficiency machines, grouped by building + recipe |
| `production_balance` | Item production vs consumption, deficits first |
| `find_item` | Which containers hold an item, how much, where |
| `logistics_status` | Trains with cargo, stations per platform, trucks, drones |
| `site_status` | One row per site (spatial cluster, default 200 m): machines by state, MW, buildings, recipes |
| `belt_load` | Belts by tier, dangling ends, belts too slow for the machine they feed or drain |
| `station_throughput` | Per station and platform: mode, status, cargo, rates, trains scheduled / inbound / docked |
| `sink_rates` | AWESOME Sink coupons, points/min, ETA to next coupon, sink buildings |
| `depot_status` | Dimensional Depot per item: stock, capacity, full, fill rate, minutes to full, when it filled |
| `battery_trend` | Battery % and power deltas per circuit over a window |
| `frm_get` | Any of ~75 raw FRM read endpoints with `filter` / `fields` / `limit` / `offset` |
| `set_enabled` | Toggle buildings by ID. Gated, off by default |
| `frm_write` | Raw POST to any FRM write endpoint. Gated, off by default |

Machine states in `site_status` are derived: **blocked** means the output
buffer is full, **starved** means an input is empty, **unpowered** means the
circuit has no capacity or a tripped fuse.

### What FRM does and doesn't expose

Field names below were verified against a live save; FRM has renamed things
across versions, so if a curated tool looks empty, hit `frm_get` on the raw
endpoint with `limit: 1` and compare keys.

- `getFactory` items: `Productivity`, `IsProducing`, `IsPaused`,
  `IsConfigured`, lowercase `ingredients` / `production` / `location`,
  `InputInventory`, `OutputInventory`, `PowerInfo`.
- `getProdStats`: `CurrentProd` / `CurrentConsumed` / `MaxProd` / `MaxConsumed`.
- `getTrainStation.CargoInventory[]` is a list of freight platforms, each with
  its own `Inventory`, `LoadingMode`, `LoadingStatus`, `DockingStatus`.
- `getBelts.ItemsPerMinute` is the tier cap, not live flow. `belt_load`
  infers problems from the machine a belt connects to instead.
- No per-building sink rate, no train dwell history, no depot upload rate.
  The trend tools derive rates from the sampler instead.

### The sampler

`sink_rates`, `depot_status`, and `battery_trend` read a ring of snapshots in
KV (`samples:ring`, 24 hours). A cron trigger samples `getPower`,
`getCloudInv`, and both sinks every 5 minutes, and every trend call adds a
sample of its own. A second daily cron purges expired OAuth data.

## Deploying your own

You need: a Cloudflare account with a zone, Satisfactory with FRM installed,
and `cloudflared` on the game machine.

1. **Tunnel.** Create a Cloudflare Tunnel on the game machine that publishes
   `localhost:8080` to a hostname on your zone, e.g. `frm.example.com`. In
   FRM's `WebServer.cfg` set `Web_Autostart: true` so the server comes up with
   the save.
2. **Access.** In Zero Trust, create a service token, then a self-hosted
   Access application for that hostname with one policy: action
   **Service Auth**, include **Service Token = your token**. Verify with curl
   that a request without headers gets 403. A token alone protects nothing
   until an application references it.
3. **Worker.** Clone this repo, then:

   ```bash
   npm install
   npx wrangler kv namespace create OAUTH_KV     # put the id in wrangler.jsonc
   ```

   Edit `wrangler.jsonc`: your `account_id`, the KV id, your Worker hostname
   under `routes`, and `FRM_BASE_URL` pointing at the tunnel hostname. Then:

   ```bash
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   npx wrangler secret put ADMIN_PASSPHRASE       # long and random; you type it once per client
   npx wrangler deploy
   ```

   If you keep secrets in 1Password, pipe them in so they never hit a
   terminal: `op read 'op://Vault/item/field' | npx wrangler secret put NAME`.

4. **Connect.** In claude.ai, Settings → Connectors → Add custom connector
   → `https://<your-worker-host>/mcp`. It redirects to the passphrase page;
   enter it once and you're done. Dynamic client registration handles the
   rest, no client id or secret to copy.

Smoke test without a client:

```bash
curl https://<your-worker-host>/.well-known/oauth-authorization-server
```

## Security model

- The game machine only exposes FRM on localhost; the tunnel is the only path in.
- Cloudflare Access rejects anything without the service token before it
  reaches the tunnel.
- The Worker holds the service token as a secret and adds it to every origin
  request. Clients never see it.
- The MCP endpoint requires an OAuth bearer token issued by the Worker.
  Issuing one requires the passphrase, compared in constant time.
- Write tools are refused unless `FRM_ALLOW_WRITE=true` is set on the Worker.
  Flip it deliberately, and consider setting FRM's own API key too.
- Service tokens expire (default one year). When yours does, rotate it in
  Zero Trust, re-put both secrets, and update cloudflared if it shares the token.

## Development

```bash
npm run typecheck
npx wrangler dev          # needs a .dev.vars with the secrets above
```

Stack: `agents` (`createMcpHandler`), `@modelcontextprotocol/server` v2,
`@cloudflare/workers-oauth-provider`, `hono`, `zod` v4, `wrangler` v4.

## License

MIT. See [LICENSE](LICENSE).
