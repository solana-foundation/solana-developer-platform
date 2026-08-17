import {
  EARN_PROVIDER_CLIENTS as CATALOGUE_PROVIDER_CLIENTS,
  isEarnProviderId,
  providerNotConfigured,
} from "@sdp/earn";
import type { EarnRuntimeContext, EarnVaultProvider } from "@sdp/earn/types";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino";
import type { EarnProviderId, SolanaCluster } from "@sdp/types";

/**
 * Resolve the process RPC only when it is not known to serve the other cluster.
 * The runtime context is request-scoped; reading it here avoids capturing one
 * process-level URL inside the provider while serving both SDP environments.
 */
function resolveKaminoRpcUrl(ctx: EarnRuntimeContext, cluster: SolanaCluster): string {
  const configuredCluster = ctx.env.SOLANA_NETWORK?.trim();
  if (configuredCluster && configuredCluster !== cluster) return "";
  return ctx.env.SOLANA_RPC_URL ?? "";
}

const kamino = new KaminoVaultDirectClient(resolveKaminoRpcUrl);
assertNotPortfolioProvider(kamino);

/**
 * API composition root for Earn providers.
 *
 * `@sdp/earn` intentionally owns the lightweight catalogue registry so its
 * cron can list Kamino without loading klend-sdk. The API owns execution, so it
 * replaces only Kamino with the vault-direct superset. Routes must resolve
 * through this registry when they need provider capabilities.
 */
export const EARN_PROVIDER_CLIENTS = {
  ...CATALOGUE_PROVIDER_CLIENTS,
  kamino,
} as const satisfies Record<EarnProviderId, EarnVaultProvider>;

export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
