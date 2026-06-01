import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIELDS } from "./fields";
import { defaultValues, generateEnv } from "./generate";

const here = path.dirname(fileURLToPath(import.meta.url));
const envExamplePath = path.resolve(here, "../../../../../infra/self-hosted/.env.example");

function baseKeysFromExample(): string[] {
  const text = fs.readFileSync(envExamplePath, "utf8");
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

test("output includes KEY=value lines for visible fields with values", () => {
  const env = generateEnv({ ...defaultValues(), CLERK_SECRET_KEY: "sk_test_x" });
  assert.match(env, /^CLERK_SECRET_KEY=sk_test_x$/m);
});

test("UI-only selector keys are never emitted", () => {
  const env = generateEnv(defaultValues());
  assert.doesNotMatch(env, /^DATABASE_MODE=/m);
  assert.doesNotMatch(env, /^CACHE_MODE=/m);
});

test("invisible conditional fields are skipped", () => {
  const env = generateEnv({ ...defaultValues(), SIGNING_PROVIDER: "local" });
  assert.doesNotMatch(env, /^FIREBLOCKS_API_KEY=/m); // fireblocks not selected
  assert.match(env, /^FEE_PAYER_PRIVATE_KEY=/m); // local selected → visible
});

test("generated .env covers every base key in infra/self-hosted/.env.example", () => {
  const env = generateEnv(defaultValues());
  const emitted = new Set(
    env
      .split("\n")
      .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean) as string[]
  );
  const fieldKeys = new Set(FIELDS.map((f) => f.key));
  for (const key of baseKeysFromExample()) {
    assert.ok(fieldKeys.has(key) || emitted.has(key), `base key not covered by form: ${key}`);
  }
});
