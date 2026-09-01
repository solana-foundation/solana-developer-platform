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
 * ── Why every entry is `null` today ─────────────────────────────────────────
 * SDP DOES NOT YET KNOW VEDA'S CANONICAL ADDRESSES, and this file is where that
 * is recorded rather than guessed.
 *
 * Two candidate sets exist and they disagree:
 *
 * - The `address` field baked into each Anchor IDL that ships inside
 *   `@vedatech/svm-sdk` (`5J76xGGXn5op…` vault, `Cchro8d7bN5X…` queue,
 *   `FSZPGBfPWb6f…` hook). MEASURED 2026-08-19 with `getAccountInfo` against
 *   `api.devnet.solana.com` and `api.mainnet-beta.solana.com`: **none of the
 *   three exists on either cluster.** They are the source repository's
 *   `declare_id!` defaults, not a deployment.
 * - Three different addresses in Veda's integration document, which SDP has
 *   only as truncated prefixes.
 *
 * The SDK is built for exactly this situation — `createVedaClient` takes every
 * program address at runtime and, per its README, "does not include default
 * addresses or infer one program from another". So the addresses are
 * deployment CONFIGURATION that Veda supplies, and the honest state until they
 * do is the one below: no deployment, every read and build failing closed with
 * `PROVIDER_NOT_CONFIGURED` rather than aiming a transaction at an address
 * nobody verified.
 *
 * A wrong address here is not a loud failure. A vault program that does not
 * exist yields "account not found", which reads exactly like an empty shelf;
 * one that exists but is not Veda's would take a `deposit` instruction and do
 * something else with the money. That asymmetry is why this stays empty until
 * Veda confirms, per cluster, in writing.
 *
 * **Filling it in is a pure data change**: replace a `null` with a
 * `VedaDeployment`. Nothing else in the stack needs to move — the catalogue
 * read, the instruction builder, the cluster guard and their tests all already
 * work against a deployment and are exercised with fixtures.
 *
 * Before filling one in, confirm with Veda, per cluster:
 *   1. the three program addresses (vault, queue, hook), and
 *   2. the vault-state address(es) SDP should catalogue, and
 *   3. whether devnet and mainnet really share addresses — the integration
 *      document implies they do, which is unusual enough to state explicitly
 *      rather than infer. `assertVedaCluster`-style genesis proof in `@sdp/earn`
 *      is what keeps a shared address from being read on the wrong chain.
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
  "mainnet-beta": null,
  devnet: null,
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
