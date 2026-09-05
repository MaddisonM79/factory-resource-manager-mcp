import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { d1 } from "./d1.ts";
import { snapshot } from "./fixtures.ts";
import { buildTick, initialState, gapState } from "../src/history.ts";
import { writeTick, writeGap, readLatest, thinSeries, type Series } from "../src/store.ts";
import { verifySession, emailOf, allowedEmails, Unauthorized, Forbidden } from "../src/dash.ts";

const T0 = 1_700_000_000;

// ---------------------------------------------------------------- trend thinning

test("thinSeries thins per series key, so a small max_points still returns every circuit group", () => {
  const points = [];
  for (let i = 0; i < 30; i++) for (const g of [0, 1, 2]) points.push({ ts: T0 + i * 300, circuit_group: g, production_mw: g * 100 + i });
  const s: Series = { epoch: 1, session: "s", res: "raw", points, gaps: [] };
  const out = thinSeries("power", s, 10);
  assert.equal(out.thinned_from, 90);
  assert.equal(out.points.length, 30);
  for (const g of [0, 1, 2]) {
    const mine = out.points.filter((p) => p.circuit_group === g);
    assert.equal(mine.length, 10, `group ${g} keeps 10 points`);
    assert.equal(mine[0].ts, T0, `group ${g} keeps its first point`);
  }
  for (let i = 1; i < out.points.length; i++) assert.ok(Number(out.points[i].ts) >= Number(out.points[i - 1].ts), "still ordered by ts");
  assert.equal(thinSeries("power", s, 30), s, "nothing to thin returns the same object");
});

test("thinSeries keys gens by fuel type + field", () => {
  const points = [];
  for (let i = 0; i < 20; i++) for (const [f, id] of [["Fuel", 0], ["Fuel", 1], ["Coal", 0]] as const) points.push({ ts: T0 + i * 300, fuel_type: f, field_id: id, dry: i });
  const out = thinSeries("gens", { epoch: 1, session: "s", res: "raw", points, gaps: [] }, 5);
  assert.equal(out.points.length, 15);
  assert.equal(out.points.filter((p) => p.fuel_type === "Fuel" && p.field_id === 1).length, 5);
});

// ---------------------------------------------------------------- latest snapshot

test("readLatest returns the newest tick from every table, resolved to lookup names, and flags a trailing gap", async () => {
  const db = d1();
  let state = initialState();
  for (const ts of [T0, T0 + 300]) {
    const tick = buildTick(snapshot({ t: ts * 1000 }), state, ts);
    await writeTick(db, tick);
    state = tick.state;
  }
  let latest = await readLatest(db);
  assert.equal(latest.ts, T0 + 300);
  assert.equal(latest.epoch, 1);
  assert.equal(latest.gap, null);
  assert.ok(latest.power.length > 0 && latest.sites.length > 0 && latest.prod.length > 0, "rows from the power, site, and prod tables");
  assert.ok(latest.sites.every((s) => "name" in s), "sites carry a lookup name (null when unresolved)");
  assert.ok(latest.gens.some((g) => g.name === "map-wide"), "map-wide generator rows are labelled");

  await writeGap(db, state, T0 + 600, "down");
  state = gapState(state);
  latest = await readLatest(db);
  assert.equal(latest.ts, T0 + 300, "the newest good tick is unchanged");
  assert.deepEqual(latest.gap, { ts: T0 + 600, reason: "down" });
});

test("readLatest on empty tables is empty, not an error", async () => {
  const latest = await readLatest(d1());
  assert.equal(latest.ts, null);
  assert.deepEqual(latest.power, []);
});

// ---------------------------------------------------------------- hanko session

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  return { privateKey, getKey: createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }) };
}

const sign = (privateKey: CryptoKey, claims: Record<string, unknown>, exp = "10m") =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt().setExpirationTime(exp).sign(privateKey);

test("verifySession accepts a signed token whose email is on the allow-list", async () => {
  const { privateKey, getKey } = await keys();
  const token = await sign(privateKey, { sub: "u1", email: { address: "Me@Example.com", is_primary: true, is_verified: true } });
  const v = await verifySession(token, getKey, ["me@example.com"]);
  assert.deepEqual(v, { sub: "u1", email: "Me@Example.com" });
});

test("verifySession rejects: wrong key, expired, missing email, and an email not on the list", async () => {
  const { privateKey, getKey } = await keys();
  const other = await keys();
  const claims = { sub: "u1", email: { address: "me@example.com" } };
  await assert.rejects(verifySession(await sign(other.privateKey, claims), getKey, ["me@example.com"]), Unauthorized);
  await assert.rejects(verifySession(await sign(privateKey, claims, "-1m"), getKey, ["me@example.com"]), Unauthorized);
  await assert.rejects(verifySession(await sign(privateKey, { sub: "u1" }), getKey, ["me@example.com"]), Forbidden);
  await assert.rejects(verifySession(await sign(privateKey, claims), getKey, ["someone@else.com"]), Forbidden);
  await assert.rejects(verifySession("not.a.jwt", getKey, ["me@example.com"]), Unauthorized);
});

test("emailOf reads both claim shapes; allowedEmails normalises", () => {
  assert.equal(emailOf({ email: "a@b.c" }), "a@b.c");
  assert.equal(emailOf({ email: { address: "a@b.c" } } as any), "a@b.c");
  assert.equal(emailOf({ sub: "x" }), null);
  assert.deepEqual(allowedEmails({ DASH_ALLOWED_EMAILS: " A@b.c, d@e.f ,, " }), ["a@b.c", "d@e.f"]);
});
