import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIELDS } from "./fields";
import { defaultValues, generateEnv } from "./generate";

const here = path.dirname(fileURLToPath(import.meta.url));
const envExamplePath = path.resolve(here, "../../../infra/self-hosted/.env.example");

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
  const env = generateEnv({
    ...defaultValues(),
    SIGNING_PROVIDER: "local",
    CUSTODY_PRIVATE_KEY: "k",
  });
  assert.doesNotMatch(env, /^FIREBLOCKS_API_KEY=/m); // fireblocks not selected
  assert.match(env, /^CUSTODY_PRIVATE_KEY=k$/m); // local selected → visible + filled
});

test("empty optional fields are omitted so runtime fallbacks apply", () => {
  // local + native default: FEE_PAYER_PRIVATE_KEY is optional and blank here, so it
  // must NOT be emitted (an empty value would defeat the native adapter's fallback).
  const env = generateEnv({
    ...defaultValues(),
    SIGNING_PROVIDER: "local",
    CUSTODY_PRIVATE_KEY: "k",
  });
  assert.doesNotMatch(env, /^FEE_PAYER_PRIVATE_KEY=/m);
});

test("a value with surrounding whitespace is emitted trimmed", () => {
  const env = generateEnv({ ...defaultValues(), CLERK_SECRET_KEY: "  sk_test_x  " });
  assert.match(env, /^CLERK_SECRET_KEY=sk_test_x$/m);
});

test("a value containing a newline cannot inject extra .env lines", () => {
  const env = generateEnv({
    ...defaultValues(),
    CLERK_SECRET_KEY: "sk_test\nINJECTED=evil",
  });
  // The CR/LF is stripped, so the key emits a single line and nothing injected.
  assert.match(env, /^CLERK_SECRET_KEY=sk_testINJECTED=evil$/m);
  assert.doesNotMatch(env, /^INJECTED=/m);
});

test("NEXT_PUBLIC_SOLANA_NETWORK is derived from SOLANA_NETWORK", () => {
  const env = generateEnv({ ...defaultValues(), SOLANA_NETWORK: "mainnet-beta" });
  assert.match(env, /^NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta$/m);
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
