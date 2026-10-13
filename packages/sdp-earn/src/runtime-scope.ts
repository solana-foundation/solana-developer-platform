import { currentClusterScope } from "@sdp/rpc/scope";
import { internalError } from "./errors";
import type { EarnRuntimeContext } from "./types";

/**
 * Refuse a provider runtime whose environment differs from the open cluster scope's: program ids
 * come from `ctx.environment` and clients from the scope, so a mismatch would read one cluster
 * with the other cluster's programs.
 *
 * @param ctx - The request's runtime context.
 * @param provider - The provider's display name, carried on the error.
 * @throws SdpEarnError `INTERNAL_ERROR` when the two environments differ.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function assertRuntimeMatchesScope(ctx: EarnRuntimeContext, provider: string): void {
  const scopeEnvironment = currentClusterScope().environment;
  if (scopeEnvironment !== ctx.environment) {
    throw internalError(
      `${provider} was asked to run on ${ctx.environment} inside a ${scopeEnvironment} cluster scope`
    );
  }
}
