import {
  KAMINO_FARMS_PROGRAM_IDS,
  KAMINO_KLEND_PROGRAM_IDS,
  KAMINO_KVAULT_PROGRAM_IDS,
  KAMINO_SLOT_DURATION_MS,
  type SolanaCluster,
} from "@sdp/types";
import { type Address, address } from "@solana/kit";

/**
 * Kamino's per-cluster runtime configuration, as `@solana/kit` addresses.
 *
 * The address TABLE itself lives in `@sdp/types/kamino-programs` because
 * `@sdp/earn` needs the devnet kvault id too and may not depend on this package
 * (see that file's header). This module is the thin typing layer: it turns those
 * strings into branded `Address`es once, at module load, so no call site
 * re-parses them and no code path can pass a raw string where an address is
 * required.
 */
export interface KaminoClusterConfig {
  cluster: SolanaCluster;
  kvaultProgramId: Address;
  klendProgramId: Address;
  farmsProgramId: Address;
  /**
   * Required by `KaminoVaultClient` and measured per cluster — never the SDK
   * default. See `KAMINO_SLOT_DURATION_MS` for the measurement and why a wrong
   * value fails silently rather than loudly.
   */
  slotDurationMs: number;
}

const CONFIG_BY_CLUSTER: Readonly<Record<SolanaCluster, KaminoClusterConfig>> = {
  "mainnet-beta": {
    cluster: "mainnet-beta",
    kvaultProgramId: address(KAMINO_KVAULT_PROGRAM_IDS["mainnet-beta"]),
    klendProgramId: address(KAMINO_KLEND_PROGRAM_IDS["mainnet-beta"]),
    farmsProgramId: address(KAMINO_FARMS_PROGRAM_IDS["mainnet-beta"]),
    slotDurationMs: KAMINO_SLOT_DURATION_MS["mainnet-beta"],
  },
  devnet: {
    cluster: "devnet",
    kvaultProgramId: address(KAMINO_KVAULT_PROGRAM_IDS.devnet),
    klendProgramId: address(KAMINO_KLEND_PROGRAM_IDS.devnet),
    farmsProgramId: address(KAMINO_FARMS_PROGRAM_IDS.devnet),
    slotDurationMs: KAMINO_SLOT_DURATION_MS.devnet,
  },
};

/**
 * The programs and timing Kamino runs under on one cluster.
 *
 * Takes a CLUSTER, never an `SdpEnvironment`. Callers holding an environment
 * convert with `CLUSTER_BY_SDP_ENVIRONMENT` (@sdp/types) at the boundary — this
 * package refuses to make that leap itself, because "environment implies
 * cluster" is exactly the assumption migration 0057 and `host_cluster` exist to
 * stop. A strategy row states the cluster its instrument lives on; that is the
 * value that belongs here.
 */
export function kaminoClusterConfig(cluster: SolanaCluster): KaminoClusterConfig {
  return CONFIG_BY_CLUSTER[cluster];
}

/**
 * Every program address this package may legitimately emit an instruction for,
 * on one cluster.
 *
 * Consumed by `assertPlanTargetsCluster` (see ./guards) as an ALLOWLIST rather
 * than a denylist: the failure being guarded against is an instruction quietly
 * addressed to the OTHER cluster's kvault program, and the only robust way to
 * catch that is to enumerate what is permitted. System/token/ATA programs are
 * cluster-invariant and are added by the guard, not here.
 */
export function kaminoProgramAllowlist(cluster: SolanaCluster): ReadonlySet<Address> {
  const config = kaminoClusterConfig(cluster);
  return new Set([config.kvaultProgramId, config.klendProgramId, config.farmsProgramId]);
}

/** The other cluster's kvault program — the one an instruction must never name. */
export function foreignKvaultProgramId(cluster: SolanaCluster): Address {
  return cluster === "devnet"
    ? CONFIG_BY_CLUSTER["mainnet-beta"].kvaultProgramId
    : CONFIG_BY_CLUSTER.devnet.kvaultProgramId;
}
