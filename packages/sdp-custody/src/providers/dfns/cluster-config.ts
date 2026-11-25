import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export const DFNS_BY_CLUSTER = {
  devnet: { origin: "https://api.dfns.io", network: "SolanaDevnet" },
  "mainnet-beta": { origin: "https://api.dfns.io", network: "Solana" },
} as const satisfies Record<SolanaCluster, { origin: string; network: string }>;

// IBM Digital Asset Haven is a white-label Dfns deployment fronted by IBM's host.
export const IBM_HAVEN_BY_CLUSTER = {
  devnet: { origin: "https://api.digitalassets.ibm.com", network: "SolanaDevnet" },
  "mainnet-beta": { origin: "https://api.digitalassets.ibm.com", network: "Solana" },
} as const satisfies Record<SolanaCluster, { origin: string; network: string }>;
