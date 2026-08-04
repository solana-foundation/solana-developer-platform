import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EARN_PROVIDERS } from "@sdp/types";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..", "..");

/**
 * Earn provider credentials follow one shape — `<ID>_API_KEY` and
 * `<ID>_SANDBOX_API_KEY` — but turbo.json globalEnv and
 * scripts/secret-keys.mjs each hand-list them, and neither fails on its own
 * when a new EARN_PROVIDERS entry forgets a key. env.d.ts drift is already a
 * compile error via keyPairCredentialDefinition; these files sit outside the
 * type system, so guard them here.
 */
describe("earn provider credential key drift", () => {
  const expectedKeys = EARN_PROVIDERS.flatMap((providerId) => {
    const prefix = providerId.toUpperCase();
    return [`${prefix}_API_KEY`, `${prefix}_SANDBOX_API_KEY`];
  });

  it("lists every earn credential key in turbo.json globalEnv", () => {
    const { globalEnv } = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as {
      globalEnv: string[];
    };
    const missing = expectedKeys.filter((key) => !globalEnv.includes(key));

    expect(missing).toEqual([]);
  });

  it("lists every earn credential key in scripts/secret-keys.mjs", () => {
    const source = readFileSync(join(repoRoot, "scripts", "secret-keys.mjs"), "utf8");
    const missing = expectedKeys.filter((key) => !source.includes(`"${key}"`));

    expect(missing).toEqual([]);
  });
});
