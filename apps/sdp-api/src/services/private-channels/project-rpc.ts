import type { SolanaRpcProbeResult } from "@sdp/private-channels";
import { type ResolvedRpcTarget, resolveRpcTarget } from "@sdp/rpc/relay";
import { createRpcFromTransport, type SolanaRpc } from "@sdp/rpc/solana";
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
  probe: () => Promise<SolanaRpcProbeResult>;
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

  return {
    cluster: CLUSTER_BY_SDP_ENVIRONMENT[environment],
    rpc,
    target,
    probe: () => probeProjectRpc(rpc),
  };
}

async function probeProjectRpc(rpc: SolanaRpc): Promise<SolanaRpcProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await rpc.getVersion().send();
    const version = response["solana-core"];
    if (!version) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: "Response missing solana-core version.",
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
