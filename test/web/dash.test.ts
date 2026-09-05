import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { verifySession, emailOf, allowedEmails, Unauthorized, Forbidden } from "../../src/web/app.ts";

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
