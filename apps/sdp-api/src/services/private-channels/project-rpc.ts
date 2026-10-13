import type { SolanaRpcProbeResult } from "@sdp/private-channels";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { SolanaCluster } from "@sdp/types";

export interface PrivateChannelProjectRpcClient {
  cluster: SolanaCluster;
  rpc: SolanaRpc;
  probe: (deployment?: PrivateChannelDeploymentProbeInput) => Promise<SolanaRpcProbeResult>;
}

export interface PrivateChannelDeploymentProbeInput {
  escrowProgramId: string;
  escrowInstanceAddr: string;
}

/**
 * The client on SDP's managed RPC pool for the open cluster scope's Private Channels work.
 *
 * The pool's endpoints are execution-only: Private Channels never persists or
 * serializes them on its instance records.
 *
 * @returns The scope's cluster, an RPC client for that cluster, and a deployment probe bound to both.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no RPC endpoint configured.
 */
export function loadProjectRpcClient(): PrivateChannelProjectRpcClient {
  const { cluster } = currentClusterScope();
  const rpc = createClusterRpc();

  return {
    cluster,
    rpc,
    probe: (deployment) => probeProjectRpcDeployment(rpc, cluster, deployment),
  };
}

/**
 * Verify that the selected project RPC can serve the configured SPC deployment.
 *
 * A version-only probe accepts a healthy endpoint on the wrong cluster. Reading
 * both escrow accounts ties the project environment to the deployment the user
 * is about to connect without persisting or exposing the resolved RPC target.
 */
export async function probeProjectRpcDeployment(
  rpc: SolanaRpc,
  cluster: SolanaCluster,
  deployment?: PrivateChannelDeploymentProbeInput
): Promise<SolanaRpcProbeResult> {
  const startedAt = Date.now();
  try {
    if (!deployment) {
      const version = (await rpc.getVersion().send())["solana-core"];
      return version
        ? { ok: true, latencyMs: Date.now() - startedAt, version }
        : {
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: "Response missing solana-core version.",
          };
    }

    const escrowProgramAddress = assertValidAddress(deployment.escrowProgramId, "escrowProgramId");
    const escrowInstanceAddress = assertValidAddress(
      deployment.escrowInstanceAddr,
      "escrowInstanceAddr"
    );
    const [versionResponse, programResponse, instanceResponse] = await Promise.all([
      rpc.getVersion().send(),
      rpc
        .getAccountInfo(escrowProgramAddress, {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
        })
        .send(),
      rpc
        .getAccountInfo(escrowInstanceAddress, {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
        })
        .send(),
    ]);
    const version = versionResponse["solana-core"];
    if (!version) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: "Response missing solana-core version.",
      };
    }

    const program = programResponse.value;
    if (!program) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `Escrow program is not deployed on ${cluster}.`,
      };
    }
    if (!program.executable) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `Escrow program is not executable on ${cluster}.`,
      };
    }

    const instance = instanceResponse.value;
    if (!instance) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `Escrow instance was not found on ${cluster}.`,
      };
    }
    if (instance.owner !== deployment.escrowProgramId) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `Escrow instance is not owned by the configured escrow program on ${cluster}.`,
      };
    }

    return { ok: true, latencyMs: Date.now() - startedAt, version };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message || "RPC probe failed." : "RPC probe failed.",
    };
  }
}
