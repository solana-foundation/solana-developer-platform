import type { SolanaRpcProbeResult } from "@sdp/private-channels";
import { type ResolvedRpcTarget, resolveRpcTarget } from "@sdp/rpc/relay";
import { createRpcFromTransport, type SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import { getDb } from "@/db";
import type { KVStoreSet } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { createTenantRpcConnectionLookup } from "@/services/rpc-connection-lookup";
import { createRpcTransportForTarget } from "@/services/rpc-egress";
import type { Env } from "@/types/env";

export interface PrivateChannelProjectRpcClient {
  cluster: SolanaCluster;
  rpc: SolanaRpc;
  target: ResolvedRpcTarget;
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
  /** Reuse the request's stores when available; jobs construct the same Redis-backed set. */
  kv?: KVStoreSet;
}

/**
 * Load a client for the same effective RPC target used by the SDP relay.
 *
 * Resolution happens for every request/job pass so provider switches and BYOK
 * credential rotation take effect immediately. The returned endpoint and
 * headers are execution-only: Private Channels never persists or serializes
 * them on its instance records.
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

  const target = await resolveRpcTarget({
    env: input.env,
    kv: input.kv ?? createKVStoreSet(input.env),
    db,
    organizationId: input.organizationId,
    authProjectId: input.projectId,
    requestedProjectId: null,
    connections: createTenantRpcConnectionLookup(input.env, db),
  });
  const rpc = createRpcFromTransport(createRpcTransportForTarget(target));
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];

  return {
    cluster,
    rpc,
    target,
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
