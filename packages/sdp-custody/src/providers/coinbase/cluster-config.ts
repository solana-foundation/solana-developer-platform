import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const COINBASE_CDP_BY_CLUSTER = {
  devnet: { origin: "https://api.cdp.coinbase.com/platform", network: "solana-devnet" },
  "mainnet-beta": { origin: "https://api.cdp.coinbase.com/platform", network: "solana" },
} as const satisfies Record<SolanaCluster, { origin: string; network: string }>;
