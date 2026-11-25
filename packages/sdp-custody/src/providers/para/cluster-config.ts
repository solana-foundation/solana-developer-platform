import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const PARA_BY_CLUSTER = {
  devnet: { origin: "https://api.beta.getpara.com" },
  "mainnet-beta": { origin: "https://api.beta.getpara.com" },
} as const satisfies Record<SolanaCluster, { origin: string }>;
