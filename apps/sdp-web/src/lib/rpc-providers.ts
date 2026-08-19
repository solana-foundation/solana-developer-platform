import type { OrganizationRpcProvider } from "@sdp/types";

/**
 * Display names for the RPC provider ids. Server-safe on purpose: the
 * integrations catalog resolves these during a server render, so the labels
 * cannot live next to the client-only connection controls.
 *
 * Settings and the integrations surface used to carry separate copies that had
 * already drifted — `default` read "SDP" on one and "SDP RPC" on the other.
 * One provider must not have two names now that both surfaces can manage it.
 */
export const RPC_PROVIDER_LABELS: Record<OrganizationRpcProvider, string> = {
  alchemy: "Alchemy",
  default: "SDP RPC",
  helius: "Helius",
  nodit: "Nodit",
  quicknode: "QuickNode",
  triton: "Triton",
  validationcloud: "Validation Cloud",
};

/** Falls back to the raw id so an unrecognised provider still renders as itself. */
export function rpcProviderLabel(provider: string): string {
  return RPC_PROVIDER_LABELS[provider as OrganizationRpcProvider] ?? provider;
}
