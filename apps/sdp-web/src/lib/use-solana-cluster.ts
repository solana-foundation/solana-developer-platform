"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/**
 * The Solana cluster for the active project: sandbox → devnet, production → mainnet-beta.
 * Use this for explorer links and any cluster-scoped href so they follow the project the
 * user is actually viewing, rather than a hardcoded network.
 */
export function useSolanaCluster(): SolanaCluster {
  const { sdpEnvironment } = useDashboardWorkspace();
  return CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment];
}
