// scripts/check-env-configurator-drift.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_LOCAL_ENV_KEYS } from "./secret-keys.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_EXAMPLE = path.join(repoRoot, "infra/self-hosted/.env.example");
const FIELDS_FILE = path.join(repoRoot, "packages/sdp-env-config/src/fields.ts");

// UI-only selectors that are not real env vars (see fields.ts UI_ONLY_KEYS).
const IGNORE = new Set(["DATABASE_MODE", "CACHE_MODE"]);

/** Keys declared in .env.example, including commented optionals (`# KEY=`). */
function readExampleKeys() {
  const text = fs.readFileSync(ENV_EXAMPLE, "utf8");
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

/** Field keys declared in fields.ts via `key: "..."` literals. */
function readFormKeys() {
  const text = fs.readFileSync(FIELDS_FILE, "utf8");
  const keys = new Set();
  for (const m of text.matchAll(/key:\s*"([A-Z0-9_]+)"/g)) keys.add(m[1]);
  return [...keys];
}

/**
 * Two authorities, two rules:
 *  - boot coverage: every .env.example key must be a form field;
 *  - validity: every form key must be a real API key OR a documented .env.example key.
 * UI-only selectors are ignored by both.
 */
export function computeDrift({ exampleKeys, formKeys, apiKeys, ignore }) {
  const form = new Set(formKeys.filter((k) => !ignore.has(k)));
  const example = new Set(exampleKeys.filter((k) => !ignore.has(k)));
  const valid = new Set([...apiKeys, ...example]);

  const missingFromForm = [...example].filter((k) => !form.has(k)).sort();
  const invalidFormKeys = [...form].filter((k) => !valid.has(k)).sort();

  return { missingFromForm, invalidFormKeys };
}

function main() {
  const { missingFromForm, invalidFormKeys } = computeDrift({
    exampleKeys: readExampleKeys(),
    formKeys: readFormKeys(),
    apiKeys: API_LOCAL_ENV_KEYS,
    ignore: IGNORE,
  });

  const sections = [];
  if (missingFromForm.length) {
    sections.push(
      [
        "Base keys in .env.example not covered by the configurator:",
        ...missingFromForm.map((k) => `- ${k}`),
      ].join("\n")
    );
  }
  if (invalidFormKeys.length) {
    sections.push(
      [
        "Form keys in neither API_LOCAL_ENV_KEYS nor .env.example (typo/rename?):",
        ...invalidFormKeys.map((k) => `- ${k}`),
      ].join("\n")
    );
  }

  if (sections.length) {
    console.error(sections.join("\n\n"));
    process.exitCode = 1;
  } else {
    console.log("env configurator drift: ok");
  }
}

// Only run when invoked directly, not when imported by the test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
