import type { SolanaCluster } from "@sdp/types";
import { type VedaDeployment, vedaDeployment } from "@sdp/types/veda-programs";
import { type Address, address } from "@solana/kit";
import { deploymentNotConfigured, SdpVedaError } from "./errors";

/**
 * Veda's per-cluster deployment, as `@solana/kit` addresses.
 *
 * The address TABLE lives in `@sdp/types/veda-programs` because `@sdp/earn`
 * needs it too for the catalogue read and may not depend on this package (see
 * that file's header). This module is the thin typing layer: it turns those
 * strings into branded `Address`es and refuses a deployment that cannot be used.
 */
export interface VedaClusterConfig {
  cluster: SolanaCluster;
  vaultProgramAddress: Address;
  /** Absent when this deployment has no withdrawal queue. */
  queueProgramAddress?: Address;
  hookProgramAddress: Address;
  vaultStateAddresses: readonly Address[];
}

function toAddress(field: string, value: string): Address {
  try {
    return address(value);
  } catch (cause) {
    throw new SdpVedaError(
      "INCOMPATIBLE_DEPLOYMENT",
      `Veda deployment ${field} ${JSON.stringify(value)} is not a valid Solana address`,
      { cause }
    );
  }
}

/**
 * The programs Veda runs under on one cluster.
 *
 * Takes a CLUSTER, never an `SdpEnvironment`. Callers holding an environment
 * convert with `CLUSTER_BY_SDP_ENVIRONMENT` (`@sdp/types`) at the boundary —
 * this package refuses to make that leap itself, because "environment implies
 * cluster" is the assumption migration 0057 and `host_cluster` exist to stop.
 *
 * Throws rather than returning null: every caller here is about to build or
 * read against these addresses, and there is no useful degraded behaviour.
 */
export function vedaClusterConfig(cluster: SolanaCluster): VedaClusterConfig {
  const deployment = vedaDeployment(cluster);
  if (!deployment) throw deploymentNotConfigured(cluster);
  return toClusterConfig(cluster, deployment);
}

/**
 * The same conversion against an explicitly supplied deployment.
 *
 * Exported so tests can exercise the whole builder against a deployment SDP
 * does not yet have (mainnet's, until Veda names a production vault under
 * PRO-1777), and the builder is the half that must already be right when
 * they do.
 */
export function toClusterConfig(
  cluster: SolanaCluster,
  deployment: VedaDeployment
): VedaClusterConfig {
  const queue = deployment.queueProgramAddress;
  return {
    cluster,
    vaultProgramAddress: toAddress("vaultProgramAddress", deployment.vaultProgramAddress),
    ...(queue === undefined
      ? {}
      : { queueProgramAddress: toAddress("queueProgramAddress", queue) }),
    hookProgramAddress: toAddress("hookProgramAddress", deployment.hookProgramAddress),
    vaultStateAddresses: deployment.vaultStateAddresses.map((value) =>
      toAddress("vaultStateAddresses", value)
    ),
  };
}

/**
 * Programs that are the same on every cluster and may appear in a plan without
 * being cluster-specific: system, both token programs, the ATA program, memo,
 * compute budget, and the Ed25519 verifier a compliance approval rides on.
 *
 * Listed explicitly rather than skipped, so the allowlist stays a CLOSED set —
 * an unexpected program is a finding, not noise.
 */
const CLUSTER_INVARIANT_PROGRAMS: readonly string[] = [
  "11111111111111111111111111111111",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "Ed25519SigVerify111111111111111111111111111",
];

/**
 * Every program address a plan for this cluster may legitimately name.
 *
 * An ALLOWLIST rather than a denylist, because the failure being guarded
 * against is an instruction quietly addressed to the OTHER cluster's
 * deployment, and enumerating what is permitted is the only robust way to catch
 * that. Cluster-invariant programs are added here rather than skipped by the
 * guard, so the set is complete and readable in one place.
 */
export function vedaProgramAllowlist(config: VedaClusterConfig): ReadonlySet<string> {
  const allowed = new Set<string>(CLUSTER_INVARIANT_PROGRAMS);
  allowed.add(String(config.vaultProgramAddress));
  allowed.add(String(config.hookProgramAddress));
  if (config.queueProgramAddress) allowed.add(String(config.queueProgramAddress));
  return allowed;
}
