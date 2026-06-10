import assert from "node:assert/strict";
import test from "node:test";
import { defaultValues } from "./generate";
import { autoSecretKeys, generateSecret, randomBase64_32, randomHex32 } from "./secrets";

test("randomHex32 returns 64 lowercase hex chars", () => {
  const s = randomHex32();
  assert.match(s, /^[0-9a-f]{64}$/);
});

test("successive calls differ", () => {
  assert.notEqual(randomHex32(), randomHex32());
});

test("randomBase64_32 decodes to 32 bytes and varies", () => {
  assert.equal(Buffer.from(randomBase64_32(), "base64").length, 32);
  assert.notEqual(randomBase64_32(), randomBase64_32());
});

test("generateSecret honors a field's secretEncoding", () => {
  assert.equal(Buffer.from(generateSecret("CUSTODY_ENCRYPTION_KEY"), "base64").length, 32);
  assert.match(generateSecret("API_KEY_PEPPER"), /^[0-9a-f]{64}$/);
});

test("autoSecretKeys without values lists only secret-kind fields", () => {
  assert.deepEqual([...autoSecretKeys()].sort(), ["API_KEY_PEPPER", "CUSTODY_ENCRYPTION_KEY"]);
});

test("autoSecretKeys with default values includes the auto-mode Postgres password", () => {
  const keys = autoSecretKeys(defaultValues());
  assert.ok(keys.has("POSTGRES_PASSWORD"));
  assert.ok(keys.has("API_KEY_PEPPER"));
});

test("autoSecretKeys excludes the Postgres password in manual mode", () => {
  const keys = autoSecretKeys({ ...defaultValues(), POSTGRES_PASSWORD_MODE: "manual" });
  assert.ok(!keys.has("POSTGRES_PASSWORD"));
});

test("autoSecretKeys still generates POSTGRES_PASSWORD with an external database", () => {
  // An external database hides POSTGRES_PASSWORD from the form, but the bundled
  // Postgres container still starts and requires it, so it is always emitted —
  // and therefore still needs an auto-generated secret.
  const keys = autoSecretKeys({ ...defaultValues(), DATABASE_MODE: "external" });
  assert.ok(keys.has("POSTGRES_PASSWORD"));
  assert.ok(keys.has("API_KEY_PEPPER"));
});

test("autoSecretKeys generates POSTGRES_PASSWORD for external DB even in manual mode", () => {
  // Manual mode only applies to the bundled database. With an external database
  // the field is hidden and unreachable, so the password must still be generated.
  const keys = autoSecretKeys({
    ...defaultValues(),
    DATABASE_MODE: "external",
    POSTGRES_PASSWORD_MODE: "manual",
  });
  assert.ok(keys.has("POSTGRES_PASSWORD"));
});
