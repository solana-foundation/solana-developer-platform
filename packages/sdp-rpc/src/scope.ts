import { AsyncLocalStorage } from "node:async_hooks";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SdpEnvironment, type SolanaCluster } from "@sdp/types";
import { SdpRpcError } from "./errors";

declare const clusterScopeBrand: unique symbol;

/**
 * The facts one unit of work runs under. Only `clusterScope` mints one, so the cluster is always
 * derived from the environment and never supplied by a caller.
 */
export type ClusterScope = Readonly<{
  projectId: string | null;
  environment: SdpEnvironment;
  cluster: SolanaCluster;
}> & { readonly [clusterScopeBrand]: true };

const scopes = new AsyncLocalStorage<ClusterScope>();

/**
 * Mint the scope facts for a Project, or for Project-less work (webhook rows, anonymous Earn).
 *
 * @param params - The work's owner.
 * @param params.projectId - The Project the work belongs to, or `null` when it has none.
 * @param params.environment - The environment that decides the cluster.
 * @returns Frozen facts with the cluster derived from `environment`.
 */
export function clusterScope(params: {
  projectId: string | null;
  environment: SdpEnvironment;
}): ClusterScope {
  return Object.freeze({
    projectId: params.projectId,
    environment: params.environment,
    cluster: CLUSTER_BY_SDP_ENVIRONMENT[params.environment],
  }) as ClusterScope;
}

/**
 * Run `operation` under `scope`. Re-entering with equal facts keeps the open scope; entering
 * with different facts throws, so work under one cluster can never start work under another.
 *
 * @param scope - Facts from `clusterScope`.
 * @param operation - The work to run; every promise it creates sees `scope`.
 * @returns Whatever `operation` returns.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` when a scope with different facts is open.
 */
export function withCluster<TResult>(scope: ClusterScope, operation: () => TResult): TResult {
  const openScope = scopes.getStore();
  if (openScope === undefined) return scopes.run(scope, operation);
  if (openScope.projectId === scope.projectId && openScope.environment === scope.environment) {
    return operation();
  }
  throw new SdpRpcError(
    "CLUSTER_SCOPE_CONFLICT",
    "A cluster scope with different facts is already open",
    {
      openProjectId: openScope.projectId,
      openEnvironment: openScope.environment,
      requestedProjectId: scope.projectId,
      requestedEnvironment: scope.environment,
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
  const openScope = scopes.getStore();
  if (openScope === undefined) {
    throw new SdpRpcError("CLUSTER_SCOPE_MISSING", "No cluster scope is open for this work");
  }
  return openScope;
}
