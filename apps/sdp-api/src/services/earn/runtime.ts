import type { EarnRuntimeContext, EarnRuntimeEnvironment } from "@sdp/earn/types";
import { currentClusterScope } from "@sdp/rpc/scope";

/**
 * The runtime an `@sdp/earn` provider client takes: this deployment's env and the open cluster
 * scope's environment. Packages never read the scope (ADR 0007), so the API hands its environment
 * over here, and a provider always works for the same environment, and so the same cluster, as the
 * request or cron around it.
 *
 * @param env - The deployment's environment variables.
 * @returns The provider runtime for the open scope.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function earnRuntime(env: EarnRuntimeEnvironment): EarnRuntimeContext {
  return { env, environment: currentClusterScope().environment };
}
