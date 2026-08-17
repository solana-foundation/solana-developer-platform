import type { SolanaCluster } from "./well-known-tokens";

/**
 * Kamino's on-chain program addresses, per cluster.
 *
 * ── Why this table lives in `@sdp/types` ────────────────────────────────────
 * Two packages need it and neither may depend on the other: `@sdp/earn` reads
 * the devnet kvault program directly (`providers/kamino/devnet.ts` filters
 * `getProgramAccounts` by it) while `@sdp/kamino` builds instructions against
 * it. Putting it in `@sdp/kamino` would force `@sdp/earn` to import the 13MB
 * klend-sdk package — a workspace cycle `scripts/check-module-boundaries.mjs`
 * rejects outright. `@sdp/types` is the leaf both already depend on, and it
 * already owns third-party on-chain addresses (`SPL_TOKEN_PROGRAMS`, `SOL_MINT`,
 * every well-known mint).
 *
 * ── The trap this table exists to prevent ───────────────────────────────────
 * KAMINO DEPLOYS A SEPARATE KVAULT PROGRAM PER CLUSTER, and mainnet's id ALSO
 * exists on devnet carrying ZERO accounts — so pointing at the wrong one yields
 * a confident empty shelf rather than an error. Worse, klend-sdk's own
 * `new KaminoVault(rpc, address, state, programId)` applies `programId` to
 * account READS only and builds its internal client without forwarding it, so
 * the naive construction (which is what Kamino's published recipe uses) reads
 * devnet state and emits MAINNET instructions. `@sdp/kamino` is the only place
 * allowed to construct a vault, and it must bind reads and writes together.
 *
 * Every address below was verified on-chain 2026-08-15.
 */

/**
 * K-Vault program — THE ONE THAT DIFFERS PER CLUSTER. Never collapse these to a
 * single constant, and never derive one from the environment without stating
 * the cluster (migration 0057 exists because environment does not imply cluster).
 */
export const KAMINO_KVAULT_PROGRAM_IDS = {
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "mainnet-beta": "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  devnet: "devkRngFnfp4gBc5a3LsadgbQKdPo8MSZ4prFiNSVmY",
} as const satisfies Record<SolanaCluster, string>;

/**
 * Kamino Lending (klend) — the program every K-Vault allocates into. Deployed at
 * the SAME address on both clusters (verified 2026-08-15), so it takes no
 * per-cluster branch. Stated as a record anyway so a future divergence is a data
 * change here rather than a hunt through call sites.
 */
export const KAMINO_KLEND_PROGRAM_IDS = {
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "mainnet-beta": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  devnet: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
} as const satisfies Record<SolanaCluster, string>;

/**
 * Kamino Farms — reward staking attached to some vaults.
 *
 * Verified 2026-08-15: deployed and executable at the same address on BOTH
 * clusters, so unlike the kvault program this is NOT a second silent-mismatch
 * trap. Checked explicitly rather than assumed, because a farms id that differed
 * per cluster would fail exactly the way the kvault one does.
 */
export const KAMINO_FARMS_PROGRAM_IDS = {
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "mainnet-beta": "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  devnet: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
} as const satisfies Record<SolanaCluster, string>;

/**
 * Average slot duration per cluster, in milliseconds — a REQUIRED input to
 * klend-sdk's `KaminoVaultClient`, and one with no safe default.
 *
 * It scales every accrual the SDK computes: exchange rate, APY, farm rewards. A
 * wrong value produces plausible WRONG NUMBERS with no error — the same
 * silent-failure class as the program-id trap above, and one no instruction
 * assertion can catch.
 *
 * MEASURED 2026-08-15 via `getBlockTime` across a 4,000-slot span on each
 * cluster's public RPC:
 *
 *   mainnet-beta  415.8 ms/slot
 *   devnet        264.5 ms/slot
 *
 * Devnet is materially faster than mainnet, and both differ from klend-sdk's own
 * `DEFAULT_RECENT_SLOT_DURATION_MS` (400) — which is why this is never left to
 * the SDK default. Re-measure and update the date above if figures look off;
 * these are observations, not protocol constants.
 */
export const KAMINO_SLOT_DURATION_MS = {
  "mainnet-beta": 416,
  devnet: 265,
} as const satisfies Record<SolanaCluster, number>;

/**
 * The devnet kvault program id, kept as a NAMED export because
 * `@sdp/earn/providers/kamino/devnet.ts` reads it directly for its
 * `getProgramAccounts` size filter and reads nothing else from this module.
 * Re-exported from the table so the two can never drift apart.
 */
export const KAMINO_DEVNET_KVAULT_PROGRAM_ID = KAMINO_KVAULT_PROGRAM_IDS.devnet;
