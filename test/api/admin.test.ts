import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeOAuth } from "../../src/api/admin.ts";

test("summarizeOAuth: grants get their client name and live token count, clients get grant counts, newest first", () => {
  const clients = [
    { clientId: "c1", clientName: "Claude", redirectUris: ["https://claude.ai/cb"], registrationDate: 100, tokenEndpointAuthMethod: "none" },
    { clientId: "c2", registrationDate: 200 },
  ];
  const grants = [
    { id: "g1", userId: "owner", clientId: "c1", scope: ["read"], createdAt: 150, metadata: { label: "frm-mcp" } },
    { id: "g2", userId: "maddie", clientId: "c1", scope: [], createdAt: 300, expiresAt: 999 },
    { id: "g3", userId: "owner", clientId: "gone", scope: [], createdAt: 50 },
  ];
  const tokens = [
    { userId: "owner", grantId: "g1", expiresAt: 500 }, { userId: "owner", grantId: "g1", expiresAt: 700 }, { userId: "maddie", grantId: "g2", expiresAt: 600 },
  ];
  const r = summarizeOAuth(clients, grants, tokens);
  assert.deepEqual(r.clients.map((c) => [c.clientId, c.clientName, c.grants]), [["c2", null, 0], ["c1", "Claude", 2]]);
  assert.deepEqual(r.grants.map((g) => [g.id, g.clientName, g.tokens, g.latestTokenExpiry, g.label]), [["g2", "Claude", 1, 600, null], ["g1", "Claude", 2, 700, "frm-mcp"], ["g3", null, 0, null, null]]);
  assert.equal(r.grants[0].expiresAt, 999);
});
