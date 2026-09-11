import type { EarnDepositTokenSymbol } from "./earn";
import { type SolanaCluster, wellKnownMint } from "./well-known-tokens";

/**
 * Ondo's on-chain deployment, per cluster.
 *
 * ── Why this table lives in `@sdp/types` ────────────────────────────────────
 * Same home and same reasoning as `./veda-programs` and `./kamino-programs`:
 * `@sdp/earn` reads it for the hourly catalogue while `@sdp/ondo` builds
 * against the same addresses, and neither package may depend on the other.
 *
 * ── What an Ondo "deployment" is ────────────────────────────────────────────
 * Unlike Kamino and Veda there is NO vault program. USDY on Solana is a plain
 * SPL token whose per-token price accrues Treasury yield (an accumulating
 * token, not a rebasing one), so the position IS the token balance and the
 * exchange rate IS the market price. SDP's deposit acquires USDY on the
 * SECONDARY market (a Jupiter-routed USDC→USDY swap) and the exit is the
 * reverse swap. The primary mint/redeem facility is deliberately not used:
 * freshly minted USDY carries a 40–50 day Reg S transfer lockup and sub-$100k
 * primary redemptions wait out that window, which is incompatible with
 * on-demand withdrawals — measured against Ondo's docs on 2026-09-02
 * (PRO-1803; docs.ondo.finance → USDY basics, eligibility, investing FAQ).
 *
 * ── Why mainnet only ────────────────────────────────────────────────────────
 * Verified on-chain 2026-09-02 (PRO-1803): the USDY mint exists on
 * mainnet-beta (plain SPL token, 6 decimals, Ondo holds mint and freeze
 * authority) and does NOT exist on devnet — nor does any other Ondo account
 * (Global Markets program, USDon). Ondo confirmed there is no devnet
 * deployment: their "staging" environment ALSO runs on mainnet, with
 * different token mints (per their partner team, 2026-09-02). So devnet stays
 * `null` the same way Veda's mainnet does, and the sandbox catalogue carries
 * Ondo only through the PRO-1742 browse-only mainnet mirror.
 *
 * Filling devnet in will never be a data change alone — there is nothing to
 * fill — but adding Ondo STAGING mints as additional mainnet strategies would
 * be, once SDP holds staging API access.
 */
export interface OndoDeployment {
  /**
   * The USDY token mint — the instrument itself. It is both the strategy's
   * `providerReference` and the position's share mint: there are no separate
   * share tokens because holding USDY is the position.
   */
  usdyMint: string;
}

/**
 * Deposit assets SDP is willing to front for Ondo, as token SYMBOLS.
 *
 * USDC only: it is the pair Ondo's own market-making liquidity quotes on
 * Solana (Jupiter routes USDC↔USDY through Orca and Ondo's Manifest
 * orderbook), so any other funding token already has a first-class path —
 * the swap-funded deposit leg converts it to USDC before this provider's own
 * swap runs.
 */
export const ONDO_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
] as const satisfies readonly EarnDepositTokenSymbol[];

/**
 * Per-cluster deployment, or `null` when the instrument does not exist there.
 *
 * Annotated rather than `as const` for the same reason as `VEDA_DEPLOYMENTS`:
 * a literal type would narrow the devnet accessor to `null` and typecheck real
 * consumers as dead code.
 */
export const ONDO_DEPLOYMENTS: Readonly<Record<SolanaCluster, OndoDeployment | null>> = {
  "mainnet-beta": {
    // Published by Ondo (docs.ondo.finance → Smart Contract Addresses) and
    // verified on-chain 2026-09-02: SPL token mint, 6 decimals.
    // biome-ignore lint/security/noSecrets: on-chain mint address, not a secret.
    usdyMint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
  },
  // No Ondo deployment exists on devnet — verified on-chain 2026-09-02, and
  // confirmed by Ondo (their staging runs on mainnet). See the header.
  devnet: null,
};

/**
 * The deployment for one cluster, or `null`.
 *
 * Takes a CLUSTER, never an `SdpEnvironment` — callers convert with
 * `CLUSTER_BY_SDP_ENVIRONMENT` at the boundary, same rule as the other
 * provider registries.
 */
export function ondoDeployment(cluster: SolanaCluster): OndoDeployment | null {
  return ONDO_DEPLOYMENTS[cluster] ?? null;
}

/** True when the USDY instrument exists on this cluster. */
export function isOndoDeployed(cluster: SolanaCluster): boolean {
  return ondoDeployment(cluster) !== null;
}

/**
 * The mints SDP will front for Ondo on one cluster, resolved from the symbols
 * above through the well-known token catalogue. Fails closed by omission —
 * a symbol with no mint on this cluster contributes nothing.
 */
export function ondoDepositMints(cluster: SolanaCluster): readonly string[] {
  return ONDO_DEPOSIT_TOKEN_SYMBOLS.map((symbol) => wellKnownMint(symbol, cluster)).filter(
    (mint): mint is string => mint !== undefined
  );
}

/**
 * Whether SDP fronts this mint for Ondo ON THIS CLUSTER — the admission rule
 * shared by the catalogue read in `@sdp/earn` and the swap builder in
 * `@sdp/ondo`, in one place so the two can never disagree. Cluster-exact mint
 * membership, never a symbol comparison (same rationale as
 * `isVedaDepositMint`).
 */
export function isOndoDepositMint(mint: string, cluster: SolanaCluster): boolean {
  return ondoDepositMints(cluster).includes(mint);
}
