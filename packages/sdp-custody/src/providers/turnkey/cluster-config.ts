import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const TURNKEY_BY_CLUSTER = {
  devnet: { origin: "https://api.turnkey.com" },
  "mainnet-beta": { origin: "https://api.turnkey.com" },
} as const satisfies Record<SolanaCluster, { origin: string }>;
