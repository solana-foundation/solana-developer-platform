import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const ANCHORAGE_BY_CLUSTER = {
  devnet: { origin: "https://api.anchorage.com", network: "solana-devnet" },
  "mainnet-beta": { origin: "https://api.anchorage.com", network: "solana" },
} as const satisfies Record<SolanaCluster, { origin: string; network: string }>;
