import {
  EARN_PROVIDER_CLIENTS as CATALOGUE_PROVIDER_CLIENTS,
  isEarnProviderId,
  providerNotConfigured,
} from "@sdp/earn";
import type { EarnRuntimeContext, EarnVaultProvider } from "@sdp/earn/types";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino";
import type { EarnProviderId, SolanaCluster } from "@sdp/types";
import {
  assertNotPortfolioProvider as assertVedaNotPortfolioProvider,
  VedaVaultDirectClient,
} from "@sdp/veda";
import type { Env } from "@/types/env";
import { assertClusterEndpoint, resolveClusterRpcUrl } from "./earn/execution-registry";
import { createVaultDeadline } from "./earn/vault-deadline";

/**
 * Resolve the request's cluster-specific RPC and prove its genesis before the
 * singleton provider performs any chain work. The runtime context is
 * request-scoped, so one API process can safely serve both SDP environments.
 */
async function resolveProvenRpcUrl(
  ctx: EarnRuntimeContext,
  cluster: SolanaCluster
): Promise<string> {
  // The API constructs this runtime from `Env`; the shared provider contract
  // deliberately narrows it to a dependency-free string record.
  const env = ctx.env as unknown as Env;
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  await assertClusterEndpoint(env, cluster, rpcUrl);
  return rpcUrl;
}

/** One fresh deadline per operation, since these clients are process singletons. */
function runVaultOperation<T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
): Promise<T> {
  const deadline = createVaultDeadline();
  return deadline.run(label, () => operation(() => deadline.assertActive(label)));
}

const kamino = new KaminoVaultDirectClient(resolveProvenRpcUrl, runVaultOperation);
assertNotPortfolioProvider(kamino);

const veda = new VedaVaultDirectClient(resolveProvenRpcUrl, runVaultOperation);
assertVedaNotPortfolioProvider(veda);

/**
 * API composition root for Earn providers.
 *
 * `@sdp/earn` intentionally owns the lightweight catalogue registry so its cron
 * can list every provider without loading a chain SDK. The API owns execution,
 * so it replaces the entries that can move money with their vault-direct
 * supersets and leaves the rest alone. Routes must resolve through this registry
 * when they need provider capabilities.
 */
export const EARN_PROVIDER_CLIENTS = {
  ...CATALOGUE_PROVIDER_CLIENTS,
  kamino,
  veda,
} as const satisfies Record<EarnProviderId, EarnVaultProvider>;

export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
