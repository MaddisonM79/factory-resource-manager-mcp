import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody } from "../../src/mcp/tools/write.ts";

test("parseBody: objects and arrays pass through, JSON strings are parsed, scalars are refused", () => {
  const o = { ID: "x", status: true };
  assert.equal(parseBody(o), o);
  assert.deepEqual(parseBody('[{"message":"hi"}]'), [{ message: "hi" }]);
  assert.deepEqual(parseBody('{"message":"hi"}'), { message: "hi" });
  assert.throws(() => parseBody("not json"), /not valid JSON/);
  assert.throws(() => parseBody('"just a string"'), /object or an array/);
  assert.throws(() => parseBody("42"), /object or an array/);
});
