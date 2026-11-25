import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const PRIVY_BY_CLUSTER = {
  devnet: { origin: "https://api.privy.io/v1" },
  "mainnet-beta": { origin: "https://api.privy.io/v1" },
} as const satisfies Record<SolanaCluster, { origin: string }>;
