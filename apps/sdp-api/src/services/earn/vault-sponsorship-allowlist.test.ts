import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { EARN_DEPOSIT_TOKEN_SYMBOLS, SOL_MINT, wellKnownMint } from "@sdp/types";
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
 * `allowed_tokens` gets the same treatment (PRO-1962). Kora does not gate
 * signing on it today, but it is the operator's declared mint set (served by
 * `getSupportedTokens`, gated on by `transferTransaction` and by token-fee
 * pricing), so it is pinned to Earn's deposit set before anything starts
 * reading it: every devnet mint in `EARN_DEPOSIT_TOKEN_SYMBOLS` must appear,
 * wrapped SOL must stay first because `resolveFeeToken` takes `tokens[0]`, and
 * the Surfpool shim's copy must match the harness exactly.
 *
 * SCOPE, stated so nobody mistakes a green run for more than it is: this proves
 * the LOCAL harness only. The deployed devnet and mainnet allowlists take a
 * live `getConfig` / `getSupportedTokens`, because only the running service
 * knows what it was actually deployed with. That is
 * `packages/sdp-api-integration/src/tests/kora-earn-sponsorship.test.ts`, which
 * runs in the Kora live-smoke shard.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_COMPOSE = resolve(HERE, "../../../../../infra/kora/docker-compose.yml");
const HARNESS_CONFIG = resolve(HERE, "../../../../../infra/kora/kora.toml");
const SURFPOOL_SHIM = resolve(
  HERE,
  "../../../../../packages/sdp-api-integration/scripts/kora-surfpool-shim.mjs"
);
const LEGACY_KORA_IMAGE = "ghcr.io/solana-foundation/kora:e9bc391";

const BASE58_ENTRY = /"([1-9A-HJ-NP-Za-km-z]{32,44})"/g;

/**
 * Pull the base58 entries out of a `<key> = [ ... ]` TOML array, in file order.
 *
 * A regex rather than a TOML parser because the repo has no TOML dependency and
 * these arrays are not worth adding one. Deliberately strict: it fails loudly
 * if the block cannot be found, so a reformatted config surfaces as a failure
 * here instead of an empty set that silently passes every subset check.
 */
function harnessArray(key: string): readonly string[] {
  const source = readFileSync(HARNESS_CONFIG, "utf8");
  const block = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)^\\]`, "m").exec(source);
  if (!block?.[1]) {
    throw new Error(`Could not find ${key} in ${HARNESS_CONFIG}`);
  }
  const entries = block[1].match(BASE58_ENTRY) ?? [];
  return entries.map((entry) => entry.replaceAll('"', ""));
}

/** The shim's `HARNESS_ALLOWED_TOKENS` literal, in source order. */
function shimAllowedTokens(): readonly string[] {
  const source = readFileSync(SURFPOOL_SHIM, "utf8");
  const block = /const HARNESS_ALLOWED_TOKENS = \[([\s\S]*?)\];/m.exec(source);
  if (!block?.[1]) {
    throw new Error(`Could not find HARNESS_ALLOWED_TOKENS in ${SURFPOOL_SHIM}`);
  }
  const entries = block[1].match(BASE58_ENTRY) ?? [];
  return entries.map((entry) => entry.replaceAll('"', ""));
}

/** The image used when KORA_IMAGE does not override the local harness. */
function harnessDefaultKoraImage(): string {
  const source = readFileSync(HARNESS_COMPOSE, "utf8");
  const match = /^\s*image:\s*\$\{KORA_IMAGE:-([^}]+)\}\s*$/m.exec(source);
  if (!match?.[1]) {
    throw new Error(`Could not find the default KORA_IMAGE in ${HARNESS_COMPOSE}`);
  }
  return match[1];
}

/** The effective transfer-hook policy, ignoring comments that explain its omission. */
function harnessTransferHookPolicy(): string | undefined {
  const source = readFileSync(HARNESS_CONFIG, "utf8");
  return /^\s*transfer_hook_policy\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(source)?.[1];
}

const HARNESS_CLUSTER = "devnet" as const;

describe("Kora harness allowlist covers every executing Earn provider", () => {
  const allowed = new Set(harnessArray("allowed_programs"));

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

describe("Kora harness allowed_tokens matches the devnet Earn deposit set", () => {
  const tokens = harnessArray("allowed_tokens");
  const expectedTokens = [
    SOL_MINT,
    ...EARN_DEPOSIT_TOKEN_SYMBOLS.flatMap((symbol) => {
      const mint = wellKnownMint(symbol, HARNESS_CLUSTER);
      return mint === undefined ? [] : [mint];
    }),
  ];

  it("matches wrapped SOL followed by every available deposit mint", () => {
    expect(tokens).toEqual(expectedTokens);
  });

  it("is mirrored verbatim by the Surfpool shim", () => {
    expect(shimAllowedTokens()).toEqual(tokens);
  });
});

describe("Kora harness image and transfer-hook policy stay compatible", () => {
  it("requires allow_all when the default image changes from the legacy pin", () => {
    const image = harnessDefaultKoraImage();
    const policy = harnessTransferHookPolicy();

    if (image === LEGACY_KORA_IMAGE) {
      expect(policy, `${LEGACY_KORA_IMAGE} rejects transfer_hook_policy`).toBeUndefined();
      return;
    }

    expect(policy, `set transfer_hook_policy when bumping ${image} from ${LEGACY_KORA_IMAGE}`).toBe(
      "allow_all"
    );
  });
});
