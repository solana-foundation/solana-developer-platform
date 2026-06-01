import assert from "node:assert/strict";
import test from "node:test";
import { autoSecretKeys, randomHex32 } from "./secrets";

test("randomHex32 returns 64 lowercase hex chars", () => {
  const s = randomHex32();
  assert.match(s, /^[0-9a-f]{64}$/);
});

test("successive calls differ", () => {
  assert.notEqual(randomHex32(), randomHex32());
});

test("autoSecretKeys lists the secret-kind field keys", () => {
  assert.deepEqual([...autoSecretKeys()].sort(), [
    "API_KEY_PEPPER",
    "CUSTODY_ENCRYPTION_KEY",
    "POSTGRES_PASSWORD",
  ]);
});
