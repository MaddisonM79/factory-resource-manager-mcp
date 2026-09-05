# Handover: FRM history (D1) branch

Branch: `claude/frm-historical-storage-api-qxecy8` (3 commits on top of `main`, all pushed).
Written 2026-09-05 at the end of a remote session; a local session continues from here.

## Where things stand

| item | state |
|---|---|
| Code, tests, README | done on the branch; `npm run typecheck` clean, `npm test` 18/18 |
| D1 database | created by Maddie: `frm-history`, id `490f5c59-4d89-41b8-beb5-8905907a4c73`, already in `wrangler.jsonc` |
| Migration `migrations/0001_history.sql` | **not applied** |
| Deploy | the last `wrangler deploy` was run from `main`, so production is still the old Worker with no `DB` binding |
| Merge to `main` | not done; no PR opened |

## Do this first (local machine)

```bash
git fetch origin claude/frm-historical-storage-api-qxecy8
git checkout claude/frm-historical-storage-api-qxecy8
npm ci
npm run typecheck && npm test
npx wrangler d1 migrations apply frm-history --remote     # must run before the new Worker's first cron tick
npx wrangler deploy                                         # bindings must now list env.DB (frm-history)
```

Five-plus minutes after deploy, sanity-check the first tick:

```bash
npx wrangler d1 execute frm-history --remote --command \
  "SELECT (SELECT COUNT(*) FROM power_samples) power, (SELECT COUNT(*) FROM site_samples) sites,
          (SELECT COUNT(*) FROM gen_samples) gens, (SELECT COUNT(*) FROM train_visits) visits,
          (SELECT COUNT(*) FROM gap_samples) gaps"
```

Expected with the game up: `sites` 11, `gens` 7 (5 field rows for Fuel, 1 for Biomass at the HUB, 2 map-wide), `power` = number of circuit groups. With the game asleep: `gaps` 1 and everything else 0. If a tick throws, the Worker logs show it (`npx wrangler tail`); the KV ring is written before D1 so the live tools keep working regardless.

Then `/api/live` and `/api/series/power?from=<now-3600>&to=<now>` with the same bearer token claude.ai uses, or the `trend` MCP tool from a Claude conversation.

## What was built

- `migrations/0001_history.sql`: 8 raw tables, 7 `hourly_*` tables (UNIQUE on `(session, epoch, bucket_ts, dimension)`), `sites` / `fields` lookups seeded from the live save.
- `src/history.ts`: pure logic. Epoch guard, spatial clustering (shared with `site_status`), machine classification, generator/depot/prod/station/sink row builders, train-visit open/close, nearest-center resolution, `buildTick`.
- `src/store.ts`: D1 writes (one batch per tick, chunked to ≤100 bound params per statement), gap row, rollup, series/visit/lookup reads.
- `src/sampler.ts`: `runTick` (KV ring + D1 batch + KV state) and `runRollup`. State between ticks lives in KV under `history:state`, so the sampler never reads D1.
- `src/api.ts`: `/api/live`, `/api/series/*`, `/api/visits`, `/api/lookup/*`. Mounted as a second `apiHandlers` route on the OAuth provider, so it gets the identical bearer check as `/mcp`.
- `src/index.ts`: `trend` MCP tool (calls the same `querySeries` as the routes), `battery_trend` reads D1 when `window_minutes` > 1440, cron wiring, `site_status` moved onto the shared clustering.
- `test/`: `node:test` with a small `node:sqlite` shim standing in for D1 (`test/d1.ts`). No new dependencies. Tests are not in the tsc project (would need `@types/node`).

## Decisions worth knowing

- **Epoch**: increments on session-name change or play-time regression. The first sample ever is epoch 1. Rates, deltas, and open train visits are never carried across an epoch boundary or a gap; after a gap the open visits are dropped (departed_ts stays NULL) rather than closed at the first post-gap sample.
- **Gap tick**: one `gap_samples` row, nothing else, `epoch`/`session`/`playtime` copied from the last known state. Hourly rollup counts gap rows into `gap_count` via a correlated subquery; gap rows and `train_visits` are never deleted.
- **Rollup**: `INSERT OR REPLACE ... SELECT ... GROUP BY` per table, then `DELETE ... WHERE ts < cutoff`, cutoff = hour-aligned `now - 7d`. Idempotent by construction; tested across the delete boundary.
- **Sites/fields have no stable id.** Raw rows store the cluster center. Hourly rows group by a 100 m cell of the center; the read path resolves each row to the nearest lookup entry within 200 m and merges same-bucket rows weighted by `sample_count`. `hourly_gen.field_id` uses `0` = map-wide and `-1` = unresolved cluster (NULL would break the UNIQUE key).
- **Map-wide generator rows are per fuel type**, not one row. Query `/api/series/gens` with no `field` to get them.
- **Lookup seeding**: the migration carries real centers. Any lookup row whose `x` is NULL is filled by the sampler on the next live tick (largest unclaimed cluster first). To add a site later: `INSERT INTO sites (name) VALUES ('...')` and wait a tick.
- **Fields count is 5, not the 4 in the spec.** At 200 m the coast plant's 5-generator row (274 m from the main block) and the HUB burners are separate clusters. Delete a `fields` row if you disagree; nothing else depends on the count.
- **Generator fuel detection** (verified live): `FuelAmount` is a number, `CanStart` false + `FuelAmount` 0 = dry. `AvailableFuel` is the list of accepted fuel types and is deliberately ignored. There is no `IsProducing` on generators.
- **`/api/series/site` (no id)** and **`gens?field=all`** return every cluster with `site_id` / `field_id` null when unresolved. Added so the "unresolved clusters return id null and their raw center" requirement has somewhere to appear.
- **Series response** is one object, or an array when the window spans epochs. Empty result is `{ epoch: null, points: [], gaps: [] }`.
- **`res` default**: raw when `to - from ≤ 7d` and `from` is inside raw retention, else hourly.

## Not verified against production yet

- The D1 batch on a real tick. Locally exercised only through the sqlite shim; D1's own limits (100 params/statement is handled; statement count per batch is not documented to have a cap) could still surprise.
- `getSchematics` is fetched every tick for the depot-expansion multiplier; if it turns out heavy, drop it from `fetchSnapshot` and the depot rows fall back to inferring the multiplier from the fullest items (same as `depot_status` already does).
- Hono routing under the OAuth provider's `/api/` prefix: dry-run bundles, but no request has hit it.
- `battery_trend` D1 path matches circuits by `circuit_group` (D1 rows don't store member circuit ids), so a rewire inside the window shows as a new group.

## Out of scope / not started

- Dashboard UI. It reads `/api/*` only.
- Per-belt or per-pipe flow history (FRM doesn't expose it).
- PR to `main`. Open one when the first live tick looks right.
