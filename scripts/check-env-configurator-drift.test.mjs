// scripts/check-env-configurator-drift.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { computeDrift } from "./check-env-configurator-drift.mjs";

const IGNORE = new Set(["DATABASE_MODE", "CACHE_MODE"]);

test("flags a base key missing from the form (boot coverage)", () => {
  const r = computeDrift({
    exampleKeys: ["CLERK_SECRET_KEY", "API_KEY_PEPPER"],
    formKeys: ["CLERK_SECRET_KEY"],
    apiKeys: ["CLERK_SECRET_KEY", "API_KEY_PEPPER"],
    ignore: IGNORE,
  });
  assert.deepEqual(r.missingFromForm, ["API_KEY_PEPPER"]);
  assert.deepEqual(r.invalidFormKeys, []);
});

test("flags a form key in neither authority (typo/rename)", () => {
  const r = computeDrift({
    exampleKeys: ["CLERK_SECRET_KEY"],
    formKeys: ["CLERK_SECRET_KEY", "FIREBLOCKZ_API_KEY"],
    apiKeys: ["CLERK_SECRET_KEY", "FIREBLOCKS_API_KEY"],
    ignore: IGNORE,
  });
  assert.deepEqual(r.invalidFormKeys, ["FIREBLOCKZ_API_KEY"]);
});

test("conditional provider key valid via API_LOCAL_ENV_KEYS even when absent from the example", () => {
  const r = computeDrift({
    exampleKeys: ["CLERK_SECRET_KEY"],
    formKeys: ["CLERK_SECRET_KEY", "FIREBLOCKS_API_KEY"],
    apiKeys: ["CLERK_SECRET_KEY", "FIREBLOCKS_API_KEY"],
    ignore: IGNORE,
  });
  assert.deepEqual(r.missingFromForm, []);
  assert.deepEqual(r.invalidFormKeys, []);
});

test("compose/web key valid via .env.example even when absent from API keys", () => {
  const r = computeDrift({
    exampleKeys: ["CLERK_SECRET_KEY", "POSTGRES_PASSWORD"],
    formKeys: ["CLERK_SECRET_KEY", "POSTGRES_PASSWORD"],
    apiKeys: ["CLERK_SECRET_KEY"],
    ignore: IGNORE,
  });
  assert.deepEqual(r.invalidFormKeys, []);
});

test("ignored UI-only keys never count as drift", () => {
  const r = computeDrift({
    exampleKeys: ["CLERK_SECRET_KEY"],
    formKeys: ["CLERK_SECRET_KEY", "DATABASE_MODE"],
    apiKeys: ["CLERK_SECRET_KEY"],
    ignore: IGNORE,
  });
  assert.deepEqual(r.invalidFormKeys, []);
});
