import { AsyncLocalStorage } from "node:async_hooks";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { SdpRpcError } from "./errors";

/** The facts one unit of work runs under; the cluster is always derived from the environment. */
export type ClusterScope = Readonly<{
  projectId: string | null;
  environment: SdpEnvironment;
  cluster: SolanaCluster;
}>;

const scopes = new AsyncLocalStorage<ClusterScope>();

/**
 * Run `operation` inside a cluster scope, so every promise it creates sees the same facts and
 * `createClusterRpc()` resolves the right cluster. Re-entering with equal facts keeps the open
 * scope; entering with different facts throws, so work under one cluster can never start work
 * under another.
 *
 * @param facts - The work's owner.
 * @param facts.projectId - The Project the work belongs to, or `null` when it has none.
 * @param facts.environment - The environment that decides the cluster.
 * @param operation - The work to run.
 * @returns Whatever `operation` returns.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` when a scope with different facts is open.
 */
export function runInClusterScope<TResult>(
  facts: { projectId: string | null; environment: SdpEnvironment },
  operation: () => TResult
): TResult {
  const openScope = scopes.getStore();
  if (openScope === undefined) {
    return scopes.run(
      Object.freeze({
        projectId: facts.projectId,
        environment: facts.environment,
        cluster: CLUSTER_BY_SDP_ENVIRONMENT[facts.environment],
      }),
      operation
    );
  }
  if (openScope.projectId === facts.projectId && openScope.environment === facts.environment) {
    return operation();
  }
  throw new SdpRpcError(
    "CLUSTER_SCOPE_CONFLICT",
    "A cluster scope with different facts is already open",
    {
      openProjectId: openScope.projectId,
      openEnvironment: openScope.environment,
      requestedProjectId: facts.projectId,
      requestedEnvironment: facts.environment,
    }
  );
}

/**
 * The facts of the scope the caller runs under.
 *
 * @returns The open scope.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no scope is open.
 */
export function currentClusterScope(): ClusterScope {
  const openScope = optionalClusterScope();
  if (openScope === undefined) {
    throw new SdpRpcError("CLUSTER_SCOPE_MISSING", "No cluster scope is open for this work");
  }
  return openScope;
}

/**
 * The open scope's facts, or `undefined` outside one. For `@sdp/rpc`'s own Earn door, which runs
 * both inside project scopes and outside any (the global Earn crons); the Biome fence keeps it out
 * of every other caller.
 *
 * @returns The open scope, if any.
 */
export function optionalClusterScope(): ClusterScope | undefined {
  return scopes.getStore();
}
