import { currentClusterScope } from "@sdp/rpc/scope";
import type { ManagedCustodyProvider } from "@sdp/types/custody";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export interface CustodyClusterConfig extends Record<ManagedCustodyProvider, { origin: string }> {
  fireblocks: { origin: string; nativeAsset: string };
  privy: { origin: string };
  coinbase_cdp: { origin: string; network: string };
  para: { origin: string };
  turnkey: { origin: string };
  dfns: { origin: string; network: string };
  ibm_haven: { origin: string; network: string };
  anchorage: { origin: string; network: string };
  utila: { origin: string; network: string };
}

export const CUSTODY_CLUSTER_CONFIG = {
  devnet: {
    // Devnet credentials come from a Fireblocks Developer Sandbox workspace, which has its own host.
    fireblocks: { origin: "https://sandbox-api.fireblocks.io", nativeAsset: "SOL_TEST" },
    privy: { origin: "https://api.privy.io/v1" },
    coinbase_cdp: { origin: "https://api.cdp.coinbase.com/platform", network: "solana-devnet" },
    para: { origin: "https://api.beta.getpara.com" },
    turnkey: { origin: "https://api.turnkey.com" },
    dfns: { origin: "https://api.dfns.io", network: "SolanaDevnet" },
    // IBM Digital Asset Haven is a white-label Dfns deployment fronted by IBM's host.
    ibm_haven: { origin: "https://api.digitalassets.ibm.com", network: "SolanaDevnet" },
    anchorage: { origin: "https://api.anchorage.com", network: "solana-devnet" },
    utila: { origin: "https://api.utila.io", network: "networks/solana-devnet" },
  },
  "mainnet-beta": {
    fireblocks: { origin: "https://api.fireblocks.io", nativeAsset: "SOL" },
    privy: { origin: "https://api.privy.io/v1" },
    coinbase_cdp: { origin: "https://api.cdp.coinbase.com/platform", network: "solana" },
    para: { origin: "https://api.beta.getpara.com" },
    turnkey: { origin: "https://api.turnkey.com" },
    dfns: { origin: "https://api.dfns.io", network: "Solana" },
    ibm_haven: { origin: "https://api.digitalassets.ibm.com", network: "Solana" },
    anchorage: { origin: "https://api.anchorage.com", network: "solana" },
    utila: { origin: "https://api.utila.io", network: "networks/solana-mainnet" },
  },
} as const satisfies Record<SolanaCluster, CustodyClusterConfig>;

export function custodyClusterConfig() {
  return CUSTODY_CLUSTER_CONFIG[currentClusterScope().cluster];
}
