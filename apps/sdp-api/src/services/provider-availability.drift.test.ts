import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EARN_PROVIDERS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { EARN_CREDENTIAL_ENV_KEYS } from "./provider-availability.service";

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
   */
  it("declares credential keys for every earn provider except the known keyless ones", () => {
    const KEYLESS_EARN_PROVIDERS = new Set(["kamino"]);
    const undeclared = EARN_PROVIDERS.filter(
      (provider) =>
        !KEYLESS_EARN_PROVIDERS.has(provider) &&
        !EARN_CREDENTIAL_ENV_KEYS.some((key) => key.startsWith(`${provider.toUpperCase()}_`))
    );

    expect(undeclared).toEqual([]);
  });
});
