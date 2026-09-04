import type { SolanaCluster } from "./well-known-tokens";

/**
 * Jupiter Lend Earn program admitted by SDP's pinned SDK integration.
 *
 * Jupiter now publishes devnet program ids, but `@jup-ag/lend@0.2.0` has no
 * cluster selector or devnet USDT market identity: its `main` context derives
 * mainnet PDAs. Keep devnet closed until the SDK can build that market
 * end-to-end instead of admitting one program id with mainnet accounts.
 */
export const JUPITER_LEND_EARN_PROGRAM_IDS = {
  devnet: undefined,
  // biome-ignore lint/security/noSecrets: public Solana program address
  "mainnet-beta": "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
} as const satisfies Record<SolanaCluster, string | undefined>;

export const JUPITER_LEND_USDT = {
  cluster: "mainnet-beta",
  // biome-ignore lint/security/noSecrets: public Solana mint address
  assetMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  // biome-ignore lint/security/noSecrets: public Solana mint address
  shareMint: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
  decimals: 6,
} as const;
