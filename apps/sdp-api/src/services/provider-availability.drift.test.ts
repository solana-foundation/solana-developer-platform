import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EARN_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";
import {
  EARN_CREDENTIAL_ENV_KEYS,
  EARN_CREDENTIAL_ENV_KEYS_BY_PROVIDER,
} from "./provider-availability.service";
import { MANAGED_RAMP_KEY_NAMES } from "./ramps/runtime";

const repoRoot = join(process.cwd(), "..", "..");

/**
 * Earn credential keys are declared by the availability definitions, but
 * turbo.json globalEnv and scripts/secret-keys.mjs each hand-list them, and
 * neither fails on its own when a new provider forgets a key. env.d.ts drift is
 * already a compile error via keyPairCredentialDefinition; these files sit
 * outside the type system, so guard them here.
 *
 * The expected set comes from `EARN_CREDENTIAL_ENV_KEYS` — the keys the
 * definitions actually read — rather than from expanding `EARN_PROVIDERS`
 * against the `<ID>_API_KEY` convention. The convention broke with Kamino,
 * whose data API is public: deriving by name would demand a `KAMINO_API_KEY`
 * that nothing reads, in a file whose contract is "every env key the SDP API
 * reads". Reading the definitions also makes the guard stronger — it now
 * follows a provider whose credential is not a key pair at all.
 */
describe("earn provider credential key drift", () => {
  it("lists every earn credential key in turbo.json globalEnv", () => {
    const { globalEnv } = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as {
      globalEnv: string[];
    };
    const missing = EARN_CREDENTIAL_ENV_KEYS.filter((key) => !globalEnv.includes(key));

    expect(missing).toEqual([]);
  });

  it("lists every earn credential key in scripts/secret-keys.mjs", () => {
    const source = readFileSync(join(repoRoot, "scripts", "secret-keys.mjs"), "utf8");
    const missing = EARN_CREDENTIAL_ENV_KEYS.filter((key) => !source.includes(`"${key}"`));

    expect(missing).toEqual([]);
  });

  /**
   * The inverse guard, and the one that keeps the change above honest: a
   * provider that DOES need a credential must not slip through by simply
   * declaring none. Only providers deliberately reached over a public API may
   * carry an empty key set, so adding one here is a decision someone makes on
   * purpose.
   *
   * Read per provider rather than by `<ID>_` prefix: Ondo gates readiness on
   * the platform `JUPITER_SWAP_API_KEY`, which a prefix match would misread as
   * "declares nothing" and wave through. Hastra is intentionally keyless at
   * the provider level; only its optional DEX rail needs that key.
   */
  it("declares credential keys for every earn provider except the known keyless ones", () => {
    const KEYLESS_EARN_PROVIDERS = new Set(["kamino", "veda", "jupiter_lend", "hastra", "plume"]);
    const undeclared = EARN_PROVIDERS.filter(
      (provider) =>
        !KEYLESS_EARN_PROVIDERS.has(provider) &&
        EARN_CREDENTIAL_ENV_KEYS_BY_PROVIDER[provider].length === 0
    );

    expect(undeclared).toEqual([]);
  });

  /**
   * And the mirror image: a provider named keyless must really declare nothing,
   * so the set above cannot quietly carry a provider that grew a credential.
   */
  it("declares no credential keys for the known keyless providers", () => {
    for (const provider of ["kamino", "veda", "jupiter_lend", "hastra", "plume"] as const) {
      expect({ provider, keys: EARN_CREDENTIAL_ENV_KEYS_BY_PROVIDER[provider] }).toEqual({
        provider,
        keys: [],
      });
    }
  });
});

/**
 * Managed ramp key names derive from each provider's key formats
 * (`MANAGED_RAMP_KEY_NAMES`), but these files hand-list them. Each must name
 * exactly that set, so a new provider's keys reach the local API and a renamed
 * key leaves no stale name behind.
 */
describe("managed ramp key drift", () => {
  const rampKeyPattern = new RegExp(
    `\\b(?:${RAMP_PROVIDERS.map((provider) => provider.toUpperCase()).join("|")})_[A-Z0-9_]+`,
    "g"
  );

  it.each([
    "turbo.json",
    "scripts/secret-keys.mjs",
    "apps/sdp-api/.env.local.example",
    "apps/sdp-api/src/types/env.d.ts",
  ])("names exactly the managed ramp keys in %s", (path) => {
    const named = new Set(readFileSync(join(repoRoot, path), "utf8").match(rampKeyPattern));

    expect([...named].sort()).toEqual([...MANAGED_RAMP_KEY_NAMES].sort());
  });
});
