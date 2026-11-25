import type { ManagedCustodyProvider } from "@sdp/types/custody";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";

type OriginRow = { origin: string };
type NetworkRow = { origin: string; network: string };

interface ClusterRowByProvider {
  fireblocks: { origin: string; nativeAsset: string };
  privy: OriginRow;
  coinbase_cdp: NetworkRow;
  para: OriginRow;
  turnkey: OriginRow;
  dfns: NetworkRow;
  ibm_haven: NetworkRow;
  anchorage: NetworkRow;
  utila: NetworkRow;
}

export type CustodyClusterConfig = {
  [Provider in ManagedCustodyProvider]: ClusterRowByProvider[Provider];
};

export const CUSTODY_CLUSTER_CONFIG = {
  devnet: {
    fireblocks: { origin: "https://api.fireblocks.io", nativeAsset: "SOL_TEST" },
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
