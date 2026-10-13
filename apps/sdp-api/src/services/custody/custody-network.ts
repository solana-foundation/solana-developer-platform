import type { DfnsNetwork } from "@sdp/custody/dfns";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaCluster } from "@sdp/types";

/** Each custody provider's name for one Solana cluster. */
export type CustodyProviderNetworks = Readonly<{
  coinbaseCdp: "solana" | "solana-devnet";
  dfns: DfnsNetwork;
  anchorage: "solana" | "solana-devnet";
  utila: "networks/solana-mainnet" | "networks/solana-devnet";
  fireblocksAssetId: "SOL" | "SOL_TEST";
}>;

const CUSTODY_PROVIDER_NETWORKS_BY_CLUSTER = {
  devnet: {
    coinbaseCdp: "solana-devnet",
    dfns: "SolanaDevnet",
    anchorage: "solana-devnet",
    utila: "networks/solana-devnet",
    fireblocksAssetId: "SOL_TEST",
  },
  "mainnet-beta": {
    coinbaseCdp: "solana",
    dfns: "Solana",
    anchorage: "solana",
    utila: "networks/solana-mainnet",
    fireblocksAssetId: "SOL",
  },
} as const satisfies Record<SolanaCluster, CustodyProviderNetworks>;

/**
 * The custody providers' network names for the cluster the caller runs under. A custody
 * wallet always lives on its project's environment's cluster, so provisioning and signing
 * read the network here and never from a request, a persisted config, or the process env.
 *
 * @returns Each provider's network name for the open scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export function currentCustodyProviderNetworks(): CustodyProviderNetworks {
  return CUSTODY_PROVIDER_NETWORKS_BY_CLUSTER[currentClusterScope().cluster];
}
