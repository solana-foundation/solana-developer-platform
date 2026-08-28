import type { SolanaCluster } from "./well-known-tokens";

/**
 * WisdomTree Connect's on-chain deployment registry for Solana.
 *
 * ── Why this table lives in `@sdp/types` ────────────────────────────────────
 * Same argument as `kamino-programs.ts`: `@sdp/earn` needs the fund identities
 * for its catalogue client while `@sdp/wisdomtree` builds instructions against
 * them, and neither package may depend on the other (the hourly catalogue cron
 * must never load a chain SDK). `@sdp/types` is the leaf both reach.
 *
 * ── What a WisdomTree "fund" IS on Solana ───────────────────────────────────
 * A registered '40 Act tokenized fund, issued as a **Token-2022 mint** with the
 * TransferHook, PermanentDelegate, Pausable and Metadata extensions. There is
 * no vault program and no deposit instruction: primary-market subscriptions
 * and redemptions settle through WisdomTree's transfer agent off-chain, and
 * the on-chain legs are plain token transfers to/from WisdomTree-operated
 * wallets (the Connect API's "on-receipt" workflow).
 *
 * Every transfer of a fund token runs `transfer-hook::execute` on the shared
 * compliance program below, which enforces WisdomTree's KYC model: a wallet
 * must hold the registrar-issued SBT credential to send or receive. A transfer
 * touching an unverified wallet FAILS ON-CHAIN — that is the backstop behind
 * SDP's own eligibility pre-check, not a replacement for it.
 *
 * ── Measurements, not documentation ─────────────────────────────────────────
 * Every address below was verified on-chain 2026-08-28 by decoding the live
 * mint account (owner = Token-2022, TokenMetadata name/symbol read from the
 * mint's own TLV, hook program read from the TransferHook extension).
 * WisdomTree's published registry (docs.wisdomtreeconnect.com) labels these
 * addresses "Program", which they are NOT — they are the mint accounts — and
 * carries at least one mislabeled row (`47tk9j…` is on-chain metadata symbol
 * EPXC, not the WTPIX the docs table claims). Trust the chain, not the table:
 * a new fund enters this registry only after its mint decodes cleanly.
 *
 * WisdomTree deploys on Solana MAINNET ONLY. Their sandbox environment is
 * Ethereum Sepolia; there is no devnet deployment of any fund or of the hook
 * program, which is why the per-cluster helpers below answer empty for devnet
 * rather than carrying a placeholder address.
 */

/**
 * The shared transfer-hook (compliance) program. Measured identical across
 * every fund mint decoded so far (WTGXX, WTSIX, and the mint the docs mislabel
 * WTPIX); stored per-cluster like every other program table so a divergence is
 * a data change here rather than a hunt through call sites.
 */
export const WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS: Partial<Record<SolanaCluster, string>> = {
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "mainnet-beta": "F4wFSShcdmaHWGRRXhCHinNTt8spgdh26Wi8hbN2Rzbh",
  // No devnet deployment exists. Absent on purpose — a placeholder here would
  // let a devnet build "succeed" against an address that serves nothing.
};

/** One tokenized fund's Solana identity. */
export interface WisdomTreeFund {
  /**
   * WisdomTree Connect's `exchange_code` — the identifier its Orders API
   * speaks (`POST /api/orders/`, `GET /api/orders/on-receipt-wallet/`).
   */
  exchangeCode: string;
  /** Display name, read from the mint's own on-chain TokenMetadata. */
  name: string;
  /** The Token-2022 mint. This is the catalogue's `providerReference`. */
  mint: string;
  /** Mint decimals, read from the live mint account. */
  decimals: number;
  cluster: SolanaCluster;
}

/**
 * The funds SDP fronts, deliberately curated rather than mirroring
 * WisdomTree's full 15-fund shelf: Earn is a stablecoin yield facility, and
 * the government money market fund is the one instrument on that shelf whose
 * mechanics match it (≈$1.00 NAV, daily dividend accrual). The equity and
 * treasury INDEX funds are tokenized brokerage exposure — price risk, not
 * yield — and belong behind a different product decision, not a registry
 * append.
 *
 * Adding a fund = decode its mint on-chain first (see the header), then add a
 * row. The catalogue client cross-checks each row against the Connect API's
 * products response before listing it.
 */
export const WISDOMTREE_FUNDS: readonly WisdomTreeFund[] = [
  {
    exchangeCode: "WTGXX",
    name: "WisdomTree Government Money Market Digital Fund",
    // biome-ignore lint/security/noSecrets: a public Solana mint address, not a credential
    mint: "Em46fxxwgY2RRoUbBMSbEjJwY62x3ESMNdhnsGpEKewm",
    decimals: 9,
    cluster: "mainnet-beta",
  },
];

/** The funds reachable on `cluster` — empty on devnet, where nothing is deployed. */
export function wisdomTreeFundsForCluster(cluster: SolanaCluster): readonly WisdomTreeFund[] {
  return WISDOMTREE_FUNDS.filter((fund) => fund.cluster === cluster);
}

/** Registry lookup by mint (the catalogue's `providerReference`). Fail-closed. */
export function wisdomTreeFundByMint(mint: string): WisdomTreeFund | undefined {
  return WISDOMTREE_FUNDS.find((fund) => fund.mint === mint);
}
