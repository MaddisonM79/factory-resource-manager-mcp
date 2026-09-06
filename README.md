# factory-resource-manager-mcp

A remote [MCP](https://modelcontextprotocol.io) server for
[Satisfactory](https://www.satisfactorygame.com/) that lets Claude (or any MCP
client) query a running factory through the
[Ficsit Remote Monitoring](https://ficsit.app/mod/FicsitRemoteMonitoring) mod.

Ask "what's asleep?", "why is caterium short?", "which depot filled first?",
"is the battery draining?" and get answers computed from live game data.

It runs as a single Cloudflare Worker: stateless MCP over Streamable HTTP,
OAuth in front of it so claude.ai can add it as a custom connector, a cron
sampler that writes 5-minute history to D1 so tools can report trends instead
of snapshots, and a small dashboard on a second hostname that charts that
history and says whether the game is up.

## How it fits together

```
claude.ai / Claude Desktop
        │  OAuth bearer token
        ▼
Cloudflare Worker  (frm-mcp)             ← this repo
  ├─ /authorize /token /register          workers-oauth-provider, KV-backed
  ├─ /mcp                                 createMcpHandler + MCP SDK v2
  ├─ /api/*                               history read API (same bearer token as /mcp)
  ├─ cron */5                             samples into KV (live, 24 h) and D1 (history)
  └─ cron daily                           OAuth purge + raw → hourly rollup
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
| `session_status` | Is the game up? Session info, players, UObject count vs capacity |
| `power_overview` | Per circuit: capacity, draw, headroom, battery, tripped fuses, and its generators (fueled/dry, load %, empty water feeds, nuclear waste and warnings, shards/sloops); plus a map-wide roll-up by fuel |
| `factory_problems` | Idle / paused / low-efficiency machines, grouped by building + recipe, with overclock / underclock counts and shards / sloops; `clock` filters on those instead |
| `production_balance` | Item production vs consumption, deficits first |
| `find_item` | Which containers hold an item, how much, where |
| `logistics_status` | Trains with cargo, stations per platform, rail signals (aspect, block validity), trucks, drone ports with FRM's rate / round-trip / fuel telemetry |
| `site_status` | One row per site (spatial cluster, default 200 m): machines by state, MW, buildings, recipes, overclocked / underclocked, shards / sloops |
| `belt_load` | Belts by tier, dangling ends, belts too slow for the machine they feed or drain, and every Throughput Counter with measured items/min vs the belt's cap |
| `pipe_load` | Pipes by tier, and every unconnected pipe end classified as phantom (touching a junction, pump, or machine but not joined) or open |
| `station_throughput` | Per station and platform: mode, status, cargo, rates, trains scheduled / inbound / docked |
| `sink_rates` | AWESOME Sink coupons, points/min, ETA to next coupon, sink buildings |
| `depot_status` | Dimensional Depot per item: stock, capacity, full, fill rate, minutes to full, when it filled |
| `emergency_reserve` | Dark-restart readiness: `*-EMERGENCY-RESERVE` switches (off, full bank behind them) and `*-TIE` switches (on), the circuit behind each reserve, issues, mode |
| `battery_trend` | Battery % and power deltas per circuit over a window; windows beyond 24 h are served from D1 history |
| `trend` | Any history series (power, site, gens, depot, prod, station, sinks, drone, counter) over a window, from D1. Same data as `/api/series/*` |
| `frm_get` | Any of the 94 raw FRM 1.5 read endpoints with `filter` / `fields` / `limit` / `offset` |
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
- `getBelts.ItemsPerMinute` is the tier cap, not live flow. Measured flow
  exists only where you build a Throughput Counter: `getThroughputCounter`
  gives `CalculatedAverage` (items/min) and `Confidence` (0..100) per
  counter, plus the belt's class and cap but not its ID, so `belt_load`
  matches counters to belts by position. Everywhere else it infers problems
  from the machine a belt connects to.
- `getTrainSignals.Aspect` is mislabelled in FRM 1.5.3: the aspect index is
  looked up in the block-validation enum, so `RBV_Valid` means Clear,
  `RBV_NoExitSignals` means Stop, `RBV_ContainsLoop` means Dock. The live
  game sends raw enum names because shipping builds strip display names;
  `trains.ts` maps raw and display spellings. `BlockValid` is correct
  (`RBV_Valid` is a properly bounded block).
- Live `getGenerators` says `Supplement.Name: "N/A"` with `PercentFull: 0`
  for generators that take no water; that is not an empty feed.
- `getDroneStation` carries FRM's own transport statistics per port:
  averaged in/out items per minute, estimated total rate, average / median /
  latest round trip, items per trip, and the active fuel's cost per trip.
  `logistics_status` and the `drone` history series read them.
- `getGenerators`: `LoadPercentage`, `Supplement.PercentFull` (water for
  coal and nuclear), `WasteInventory` and `NuclearWarning` (nuclear),
  `PowerShards`, `Somersloops`. `getFactory`: `ManuSpeed` is the clock in
  percent, `PowerShards`, `Somersloops`.
- `getAll` still registers in FRM 1.5 but is retired and answers with an
  error object, so it is not in the registry.
- `getGenerators`: `FuelAmount` (number), `CanStart`, `ProductionCapacity`.
  `AvailableFuel` lists the fuel types a generator accepts, not its stock.
  The HUB burners are `Build_GeneratorIntegratedBiomass_C`.
- `getTrains.Docking` is `TDS_Docked` / `TDS_None`; `TrainStation` is the
  station the train is at or heading to.
- No per-building sink rate, no train dwell history, no depot upload rate.
  The trend tools derive rates from the sampler instead.

### The sampler

`sink_rates`, `depot_status`, and `battery_trend` read a ring of snapshots in
KV (`samples:ring`, 24 hours). A cron trigger samples `getPower`,
`getCloudInv`, and both sinks every 5 minutes, and every trend call adds a
sample of its own. The KV ring is the live view; D1 is history.

### History (D1)

Every 5-minute tick also fetches `getFactory`, `getGenerators`,
`getProdStats`, `getTrainStation`, `getTrains`, `getDroneStation`, and
`getThroughputCounter`, and writes one D1 batch:

| table | one row per | notes |
|---|---|---|
| `power_samples` | circuit group | capacity, production, draw, battery, fuse |
| `site_samples` | spatial cluster of machines (200 m) | counts by state, MW, productivity, cluster center |
| `gen_samples` | (fuel type, generator field) | plus a map-wide row per fuel type with `field_id = 0`; `load_pct`, nuclear `waste` |
| `depot_samples` | depot item | stock, capacity, full |
| `prod_samples` | item | straight from `getProdStats` |
| `station_samples` | freight platform | mode, cargo, rate, docked train, inbound count |
| `train_visits` | dock/undock | opened when a train docks, closed when it leaves; `delta_cargo` = platform stock at arrival minus at departure |
| `sink_samples` | sink | coupons, points to next, points/min |
| `drone_samples` | drone port | status, pairing, in/out items per min, est. rate, latest round trip, items per trip, fuel, stocks |
| `counter_samples` | throughput counter | belt class and cap, measured items/min, confidence |
| `gap_samples` | unreachable tick | the only row written that tick |

Every sample row carries `ts`, `session` (FRM `SessionName`), `playtime`, and
`epoch`. The epoch increments when the session name changes or play time goes
backwards (a save was reloaded); no rate, delta, or train visit ever crosses
an epoch boundary or a gap. Raw rows are kept for 7 days; the daily cron rolls
older hours into `hourly_*` tables (AVG, plus MIN/MAX for `running`,
`blocked`, `starved`, `dry`, `stock`) with `sample_count` and `gap_count`.
The rollup is idempotent. `train_visits` and `gap_samples` are never rolled
up or deleted.

Sites and generator fields are spatial clusters, not stable ids. The sampler
stores cluster centers; the read API resolves them to the `sites` / `fields`
lookup tables by nearest center within 200 m. The migration seeds the 11
sites and 5 generator fields of the current save with real centers and
recipe-based names; rename them with
`PATCH /api/lookup/sites/:id {"name": "Iron Row"}` (`x`, `y`, `z` can be
patched too). A lookup row whose coordinates are NULL is filled in by the
sampler on the next live tick, largest unclaimed cluster first, so a new
site only needs a name. Clusters that match nothing come back with
`site_id: null` and their raw center.

#### Read API

Same bearer token as `/mcp`. All series take `from`, `to` (unix seconds,
default the last 24 h) and optional `res=raw|hourly`; when omitted, raw for
windows of ≤ 7 days inside raw retention, hourly otherwise.

```
GET /api/status                        live getSessionInfo + getPlayer, plus sampler staleness
GET /api/emergency                     live dark-restart readiness (?min_charge_pct=95)
GET /api/trains                        live trains (timetable, cargo, errors), stations (platforms, docked, inbound, scheduled), signals (aspect, block validity)
GET /api/latest                        newest tick from every table, sites/fields resolved to names
GET /api/live                          KV ring + staleness_seconds (?minutes=)
GET /api/series/power                  ?group= for one circuit group
GET /api/series/site/:id               one site;  /api/series/site = every cluster, resolved
GET /api/series/gens?field=:id         omit field for map-wide; field=all for every cluster
GET /api/series/depot/:item
GET /api/series/prod/:item
GET /api/series/station/:name
GET /api/series/sinks
GET /api/series/drone/:station           /api/series/drone = every port
GET /api/series/counter/:id              FRM counter ID (or name); /api/series/counter = every counter
GET /api/visits?station=&train=&from=&to=
GET /api/lookup/sites                  PATCH /api/lookup/sites/:id
GET /api/lookup/fields                 PATCH /api/lookup/fields/:id
```

A series is `{ epoch, session, res, points: [{ ts, ... }], gaps: [{ from, to }] }`;
when the window spans epochs you get an array of them. Hourly points add
`sample_count` and `gap_count`; treat `gap_count > 0` as low confidence.
Nothing under `/api` can reach the FRM tunnel.

## Dashboard

`app.<zone>` serves `src/web/static/`: one page, plain ES module, uPlot for charts,
no build step. It shows whether the game answered just now (`/api/status`
calls `getSessionInfo` and `getPlayer` live, the one place under `/api` that
reaches the tunnel), then tabs for power per circuit group, item production
vs consumption, sites by machine state, generator fields (with load % and
nuclear waste), the depot, and the
sinks, an Emergency tab for the dark-restart reserves, and a Trains tab
(every train with its timetable, cargo and errors; every station with its
platforms, what is docked or inbound and which trains schedule it; the dock
history from `train_visits` with dwell and cargo moved; a station's transfer
rate over time; every signal at Stop or on an invalid block, with the full
list behind a toggle). Every chart takes the same time range (1 h to 30 d) and a Local / UTC
toggle in the header; outages are shaded, save reloads are marked with the
session name, and nothing is interpolated across either. Tables come from
`/api/latest`, the newest tick from every history table with sites and
fields resolved to their lookup names.

Emergency reserves are a naming convention. A power switch named
`<SITE>-EMERGENCY-RESERVE` is expected **off** with a full battery bank behind
it; `<SITE>-TIE` is the site's cut-off from the main grid, expected **on**.
A dark restart turns the ties off and the reserves on. `emergency_reserve`
and `/api/emergency` pair them by site and report every deviation: a reserve
that is on, a bank below the threshold, a discharging or loaded reserve side,
a tripped fuse, a tie that is off. A switch not built yet, or a side with no
cable, is a note rather than an issue. Switch state is always on/off (FRM's
`IsOn`); "open" is avoided because it means opposite things to different
people. The circuit topology is a cross-check: an off switch whose two sides
still resolve to one power group is bypassed by another cable path and does
not isolate anything by itself, which is reported as a note.

Sign-in is [Hanko](https://hanko.io): the login element stores its JWT in a
first-party `hanko` cookie, the Worker verifies it against the project's JWKS
(`jose`) and then checks the email claim against `DASH_ALLOWED_EMAILS`. A
valid Hanko session for anyone else is a 403, so turning registration off in
the Hanko project is belt and braces, not the only lock. `MCP_HOSTS` and
`DASH_HOST` in `wrangler.jsonc` decide which hostname gets which app; the
dashboard host never touches the OAuth provider.

## Deploying your own

You need: a Cloudflare account with a zone, Satisfactory with FRM installed,
and `cloudflared` on the game machine.

1. **Tunnel.** Create a Cloudflare Tunnel on the game machine that publishes
   `localhost:8080` to a hostname on your zone, e.g. `frm.example.com`. Keep
   it a first-level subdomain: the tunnel's CNAME relies on Universal SSL,
   which does not cover `a.b.example.com` (Worker custom domains get their
   own certificate, so the `mcp.` and `app.` names can be as deep as you
   like). In FRM's `WebServer.cfg` set `Web_Autostart: true` so the server
   comes up with the save.
2. **Access.** In Zero Trust, create a service token, then a self-hosted
   Access application for that hostname with one policy: action
   **Service Auth**, include **Service Token = your token**. Verify with curl
   that a request without headers gets 403. A token alone protects nothing
   until an application references it.
3. **Worker.** Clone this repo, then:

   ```bash
   npm install
   npx wrangler kv namespace create OAUTH_KV     # put the id in wrangler.jsonc
   npx wrangler d1 create frm-history            # put the database_id in wrangler.jsonc
   npx wrangler d1 migrations apply frm-history --remote
   ```

   Edit `wrangler.jsonc`: your `account_id`, the KV and D1 ids, your Worker
   hostname under `routes`, and `FRM_BASE_URL` pointing at the tunnel
   hostname. Then:

   ```bash
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   npx wrangler secret put ADMIN_PASSPHRASE       # long and random; you type it once per client
   npx wrangler deploy
   ```

   If you keep secrets in 1Password, pipe them in so they never hit a
   terminal: `op read 'op://Vault/item/field' | npx wrangler secret put NAME`.

4. **Connect.** In claude.ai, Settings → Connectors → Add custom connector
   → `https://<your-mcp-host>/mcp`. It redirects to the passphrase page;
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
npm test                  # node:test + node:sqlite standing in for D1; no extra deps
npx wrangler dev          # needs a .dev.vars with the secrets above
npx wrangler d1 migrations apply frm-history --local
```

Stack: `agents` (`createMcpHandler`), `@modelcontextprotocol/server` v2,
`@cloudflare/workers-oauth-provider`, `hono`, `zod` v4, `wrangler` v4.

## License

MIT. See [LICENSE](LICENSE).
