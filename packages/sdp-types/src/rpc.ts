/**
 * Why Solana RPC is unavailable to a request, in an `RPC_UNAVAILABLE` (503) error's
 * `details.reason`:
 *
 * - `not_configured`: the cluster has no usable endpoint. Not transient: retrying won't help.
 * - `cluster_mismatch`: an endpoint serves another cluster than its slot names. Not transient.
 * - `upstream_unavailable`: the providers timed out, rate-limited or failed after failover.
 *   Transient: the response carries `Retry-After`.
 */
export const RPC_UNAVAILABLE_REASONS = [
  "not_configured",
  "cluster_mismatch",
  "upstream_unavailable",
] as const;

export type RpcUnavailableReason = (typeof RPC_UNAVAILABLE_REASONS)[number];

/** The providers in SDP's managed RPC pool. `default` is the operator's fallback endpoint, not a provider a project sees. */
export const MANAGED_RPC_PROVIDERS = [
  "alchemy",
  "default",
  "helius",
  "nodit",
  "quicknode",
  "triton",
  "validationcloud",
] as const;
export type ManagedRpcProvider = (typeof MANAGED_RPC_PROVIDERS)[number];
