import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const UTILA_BY_CLUSTER = {
  devnet: { origin: "https://api.utila.io", network: "networks/solana-devnet" },
  "mainnet-beta": { origin: "https://api.utila.io", network: "networks/solana-mainnet" },
} as const satisfies Record<SolanaCluster, { origin: string; network: string }>;
