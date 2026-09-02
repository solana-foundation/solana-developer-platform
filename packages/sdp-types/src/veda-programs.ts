import type { EarnDepositTokenSymbol } from "./earn";
import { type SolanaCluster, wellKnownMint } from "./well-known-tokens";

/**
 * Veda's on-chain deployment, per cluster.
 *
 * ── Why this table lives in `@sdp/types` ────────────────────────────────────
 * Two packages need it and neither may depend on the other: `@sdp/earn` reads
 * vault state directly for the hourly catalogue (`providers/veda/vault-state.ts`)
 * while `@sdp/veda` builds deposit instructions against the same programs.
 * Putting it in `@sdp/veda` would force the catalogue cron to load a chain SDK
 * it never calls — a workspace cycle `scripts/check-module-boundaries.mjs`
 * rejects outright. Same argument as `./kamino-programs`, and the same home.
 *
 * ── What is filled in, and why mainnet is still `null` ──────────────────────
 * DEVNET is confirmed (2026-08-31), from two independent sources that agree:
 *
 * - Veda's integration docs — the deployment-configuration table an
 *   integration passes to `createVedaClient()` — name the three programs, the
 *   Test Vault's vault-state address, and devnet USDC, per cluster.
 * - SDP's own on-chain audit (2026-08-17, veda-svm-sdk-audit harness; reports
 *   committed at `docs/earn/veda-svm-audit/`) measured the same addresses
 *   against genesis-proved endpoints: all three programs exist and are
 *   executable, the vault state is owned by the vault program, its asset
 *   config references THIS cluster's USDC (`4zMMC9srt…`, exactly the
 *   well-known devnet USDC mint) and not mainnet's, and a full signed
 *   deposit → queued-withdrawal → cancel lifecycle landed on devnet.
 *
 * That answers the three questions this file used to hold open: the program
 * addresses, the vault-state allowlist, and the docs' unusual claim that
 * devnet and mainnet share addresses (they do — measured, not inferred; the
 * genesis proof in `@sdp/earn` is what keeps the shared address from ever
 * being read on the wrong chain).
 *
 * MAINNET stays `null` deliberately, and not for lack of addresses: the same
 * docs table names the same programs and the SAME vault state for mainnet, and
 * the audit found them live there too. But that vault is Veda's shared TEST
 * vault (share supply was ~4 USDC when measured), and a mainnet entry here
 * puts its row on the PRODUCTION catalogue for every customer. Fill mainnet
 * only when Veda names the production vault(s) SDP should actually offer —
 * and note a wrong address is not a loud failure: a program that does not
 * exist reads as an empty shelf, while one that exists but is not Veda's would
 * take a `deposit` instruction and do something else with the money.
 *
 * Historical note, kept because it explains why nothing is inferred from the
 * SDK: the `address` fields baked into `@vedatech/svm-sdk`'s Anchor IDLs
 * (`5J76xGGXn5op…` vault, `Cchro8d7bN5X…` queue, `FSZPGBfPWb6f…` hook) are the
 * source repository's `declare_id!` defaults — measured 2026-08-19, none of
 * the three exists on either cluster. `createVedaClient` takes every address
 * at runtime and "does not include default addresses or infer one program
 * from another"; this table is that configuration.
 *
 * **Filling mainnet in is a pure data change**: replace the `null` with a
 * `VedaDeployment`. Nothing else in the stack needs to move — the catalogue
 * read, the instruction builder, the cluster guard and their tests all already
 * work against a deployment.
 */
export interface VedaDeployment {
  /**
   * `boring_vault_svm` — holds vault state, mints shares, and executes deposits
   * and instant withdrawals.
   */
  vaultProgramAddress: string;
  /**
   * `boring_onchain_queue` — the request → fulfill → cancel withdrawal queue.
   *
   * Optional because the SDK reports a deployment without a queue as a
   * supported capability state rather than an error. A cluster whose queue is
   * absent simply offers no queued withdrawal, and
   * `vault.validateCompatibility({ requireQueue: true })` is how a caller that
   * needs one says so.
   */
  queueProgramAddress?: string;
  /**
   * `hook_program` — the Token-2022 transfer hook on the share mint. Required:
   * share transfers (including the ones a deposit and a withdrawal perform)
   * route through it, so a deployment without it cannot move shares at all.
   */
  hookProgramAddress: string;
  /**
   * The vault-state accounts SDP catalogues on this cluster.
   *
   * An explicit allowlist, never a program-account census. Veda vaults are
   * deployed per customer, so the program's account set includes other
   * integrators' vaults; enumerating it would put someone else's vault on SDP's
   * shelf. It is also what makes `riskMetadata` and `sourceKind` defensible —
   * every catalogued row traces to an address Veda named, which is the same bar
   * the Kamino curator rule sets (see `packages/sdp-earn/CLAUDE.md`).
   */
  vaultStateAddresses: readonly string[];
}

/**
 * Deposit assets SDP is willing to front for Veda, as token SYMBOLS.
 *
 * Declared cluster-agnostically and bridged to mints through the well-known
 * token catalogue, matching `EarnDeclaredStrategySupport`. USDC only: it is the
 * asset Veda's integration material describes, and it is the only one of the
 * three Earn deposit symbols that has a devnet mint, so a wider declaration
 * would be a claim SDP could not exercise in sandbox anyway.
 *
 * This is a CEILING, not a promise. The live vault decides what it accepts; the
 * catalogue intersects the two, so widening this never admits an asset the
 * vault has disabled.
 */
export const VEDA_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
] as const satisfies readonly EarnDepositTokenSymbol[];

/**
 * Per-cluster deployment, or `null` when SDP has no confirmed one.
 *
 * Annotated rather than `as const`: with both entries `null` a literal type
 * would narrow the accessor's return to `null`, and every consumer of a real
 * deployment would typecheck as dead code — including the tests that prove
 * those paths work.
 */
export const VEDA_DEPLOYMENTS: Readonly<Record<SolanaCluster, VedaDeployment | null>> = {
  // The production vault set is an offering decision Veda has not made yet —
  // the published mainnet addresses point at their shared Test Vault. See the
  // header before filling this in.
  "mainnet-beta": null,
  // Veda's devnet Test Vault deployment, from their integration docs and
  // measured on chain (see header). Addresses are identical on mainnet.
  devnet: {
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    vaultProgramAddress: "ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J",
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    queueProgramAddress: "fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT",
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    hookProgramAddress: "BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2",
    // biome-ignore lint/security/noSecrets: on-chain account address, not a secret.
    vaultStateAddresses: ["3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU"],
  },
};

/**
 * The deployment for one cluster, or `null`.
 *
 * Takes a CLUSTER, never an `SdpEnvironment`. Callers holding an environment
 * convert with `CLUSTER_BY_SDP_ENVIRONMENT` at the boundary — "environment
 * implies cluster" is the assumption migration 0057 and `host_cluster` exist to
 * stop, and a provider whose devnet and mainnet deployments may share addresses
 * is exactly where that assumption would go unnoticed.
 */
export function vedaDeployment(cluster: SolanaCluster): VedaDeployment | null {
  return VEDA_DEPLOYMENTS[cluster] ?? null;
}

/** True when SDP has a confirmed Veda deployment for this cluster. */
export function isVedaDeployed(cluster: SolanaCluster): boolean {
  return vedaDeployment(cluster) !== null;
}

/**
 * The mints SDP will front for Veda on one cluster, resolved from the symbols
 * above through the well-known token catalogue.
 *
 * Fails closed by omission: a symbol with no mint on this cluster (USDT has no
 * devnet mint, for instance) simply contributes nothing, rather than producing
 * a mint address that does not exist there.
 */
export function vedaDepositMints(cluster: SolanaCluster): readonly string[] {
  return VEDA_DEPOSIT_TOKEN_SYMBOLS.map((symbol) => wellKnownMint(symbol, cluster)).filter(
    (mint): mint is string => mint !== undefined
  );
}

/**
 * Whether SDP fronts this mint for Veda ON THIS CLUSTER — the admission rule,
 * in ONE place.
 *
 * Two very different code paths ask it and they must never disagree: the
 * catalogue read in `@sdp/earn` decides which of a vault's enabled assets
 * become a row's `depositMints`, and the builder in `@sdp/veda` decides which
 * asset a deposit instruction spends. A row admitted under one rule and spent
 * under another is how a deposit ends up moving a token the ledger did not
 * record, which is exactly what `EarnVaultAssetIdentity` exists to catch — and
 * a check that fires is still a customer-visible failure, so the two sides
 * share this predicate rather than each restating it.
 *
 * CLUSTER-AWARE by exact mint membership, never a symbol comparison. Mainnet
 * USDC and devnet USDC share a symbol but are different mints, so a
 * symbol-level check would admit the OTHER cluster's mint — a devnet vault
 * whose asset config named mainnet USDC would catalogue (and try to spend) a
 * mint that does not exist on devnet, failing only downstream as "account not
 * found".
 *
 * Fails closed on an unknown mint: a mint the well-known catalogue does not
 * carry is not something SDP fronts anywhere.
 */
export function isVedaDepositMint(mint: string, cluster: SolanaCluster): boolean {
  return vedaDepositMints(cluster).includes(mint);
}
