import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { resolveEarnExecutionClient } from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";

/**
 * Kora rejects a sponsored transaction wholesale if it touches a program that is
 * not in `allowed_programs`. That list lives in TOML, in this repo for the local
 * harness and in sdp-infra for the two deployed services, and none of those
 * files can import a provider's program set.
 *
 * This closes the gap for the harness the cheapest way there is: every provider
 * the execution registry can build a vault-direct client for must have its
 * declared programs already covered. Adding a provider client enrolls it here
 * with no edit, which is the property that makes sponsorship inheritable rather
 * than remembered.
 *
 * SCOPE, stated so nobody mistakes a green run for more than it is: this proves
 * the LOCAL harness only. The deployed devnet and mainnet allowlists take a
 * live `getConfig`, because only the running service knows what it was actually
 * deployed with. That is
 * `packages/sdp-api-integration/src/tests/kora-earn-sponsorship.test.ts`, which
 * runs in the Kora live-smoke shard.
 */
const HARNESS_CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../infra/kora/kora.toml"
);

/**
 * Pull the base58 entries out of `allowed_programs = [ ... ]`.
 *
 * A regex rather than a TOML parser because the repo has no TOML dependency and
 * this one array is not worth adding one. Deliberately strict: it fails loudly
 * if the block cannot be found, so a reformatted config surfaces as a failure
 * here instead of an empty set that silently passes every subset check.
 */
function harnessAllowedPrograms(): ReadonlySet<string> {
  const source = readFileSync(HARNESS_CONFIG, "utf8");
  const block = /^allowed_programs\s*=\s*\[([\s\S]*?)^\]/m.exec(source);
  if (!block?.[1]) {
    throw new Error(`Could not find allowed_programs in ${HARNESS_CONFIG}`);
  }
  const entries = block[1].match(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g) ?? [];
  return new Set(entries.map((entry) => entry.replaceAll('"', "")));
}

const HARNESS_CLUSTER = "devnet" as const;

describe("Kora harness allowlist covers every executing Earn provider", () => {
  const allowed = harnessAllowedPrograms();

  it("parsed a non-trivial allowlist", () => {
    // Guards the guard: a regex that matched nothing would make every
    // assertion below vacuously true.
    expect(allowed.size).toBeGreaterThan(5);
  });

  it.each(EARN_PROVIDERS)("%s", (provider) => {
    const client = resolveEarnExecutionClient({} as Env, provider, createVaultDeadline());
    if (!client || !supportsVaultDirect(client)) {
      // This deployment cannot execute for the provider, so it has nothing to
      // sponsor. Not a skip: "no executing client" is the assertion.
      expect(true).toBe(true);
      return;
    }

    const missing = client
      .sponsoredPrograms(HARNESS_CLUSTER)
      .filter((program) => !allowed.has(program));

    expect(missing, `add these to ${HARNESS_CONFIG} (and to both configs in sdp-infra)`).toEqual(
      []
    );
  });
});
