import type { SolanaRpcProbeResult } from "@sdp/private-channels";
import { createClusterRpc, type SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import { getDb } from "@/db";
import type { Env } from "@/types/env";

export interface PrivateChannelProjectRpcClient {
  cluster: SolanaCluster;
  rpc: SolanaRpc;
  probe: (deployment?: PrivateChannelDeploymentProbeInput) => Promise<SolanaRpcProbeResult>;
}

export interface PrivateChannelDeploymentProbeInput {
  escrowProgramId: string;
  escrowInstanceAddr: string;
}

export interface LoadProjectRpcClientInput {
  env: Env;
  organizationId: string;
  projectId: string;
  /** Already known on authenticated requests; jobs resolve it from the project row. */
  environment?: SdpEnvironment;
}

/**
 * Load a client on SDP's managed RPC pool for a project's Private Channels work.
 *
 * The pool's endpoints are execution-only: Private Channels never persists or
 * serializes them on its instance records.
 *
 * @param input - The project to load the client for.
 * @param input.env - Process env carrying the managed RPC pool.
 * @param input.organizationId - Organization that owns the project.
 * @param input.projectId - Project whose environment picks the cluster.
 * @param input.environment - The project's environment when the caller already knows it; otherwise read from the active project row.
 * @returns The project's cluster, an RPC client for that cluster, and a deployment probe bound to both.
 * @throws Error when the project is not active in the organization, or when the deployment has no RPC endpoint for the project's cluster.
 */
export async function loadProjectRpcClient(
  input: LoadProjectRpcClientInput
): Promise<PrivateChannelProjectRpcClient> {
  const db = getDb(input.env);
  const environment =
    input.environment ??
    (
      await db
        .prepare(
          `SELECT environment
           FROM projects
          WHERE id = ? AND organization_id = ? AND status = 'active'`
        )
        .bind(input.projectId, input.organizationId)
        .first<{ environment: SdpEnvironment }>()
    )?.environment;

  if (!environment) {
    throw new Error(`Active project ${input.projectId} was not found while resolving its RPC`);
  }

  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];
  const rpc = createClusterRpc(input.env, cluster);

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
