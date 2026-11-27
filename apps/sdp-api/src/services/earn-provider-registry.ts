import { EARN_PROVIDER_CLIENTS as CATALOGUE_PROVIDER_CLIENTS, isEarnProviderId } from "@sdp/earn";
import { providerNotConfigured } from "@sdp/earn/errors";
import type {
  EarnProvenRpcResolver,
  EarnVaultOperationRunner,
  EarnVaultProvider,
} from "@sdp/earn/types";
import { EARN_PROVIDERS, type EarnProviderId } from "@sdp/types/provider-access";
import {
  assertClusterEndpoint,
  earnPoolNotConfigured,
  earnProviderEndpointUrls,
} from "@/services/earn/cluster-rpc";
import type { Env } from "@/types/env";
import {
  createEarnExecutionClient,
  type EarnExecutionDependencies,
} from "./earn/execution-factories";
import { createHastraSwapPort } from "./earn/hastra-swap-port";
import { createJupiterSwapPort } from "./earn/jupiter-swap-port";
import { createVaultDeadline } from "./earn/vault-deadline";

/**
 * The preferred endpoint of the request's cluster pool, proven before the
 * singleton provider performs any chain work. The cluster comes from the
 * request-scoped runtime, so one API process serves both SDP environments.
 */
const resolveProvenRpcUrl: EarnProvenRpcResolver = async (_ctx, cluster) => {
  const [rpcUrl] = earnProviderEndpointUrls(cluster);
  if (rpcUrl === undefined) throw earnPoolNotConfigured(cluster);
  await assertClusterEndpoint(cluster, rpcUrl);
  return rpcUrl;
};

/** One fresh deadline per operation, since these clients are process singletons. */
const runVaultOperation: EarnVaultOperationRunner = (label, operation) => {
  const deadline = createVaultDeadline();
  return deadline.run(label, () => operation(() => deadline.assertActive(label)));
};

const singletonDependencies: EarnExecutionDependencies = {
  resolveProvenRpcUrl,
  runOperation: runVaultOperation,
  // SAFETY: earnRuntime passes the deployment Env unchanged at this API boundary.
  resolveJupiterSwapPort: (ctx) => createJupiterSwapPort(ctx.env as Env, "Jupiter swaps"),
  // SAFETY: these singletons resolve the current request's Env only when the port is used.
  resolveHastraSwapPort: (ctx) => createHastraSwapPort(ctx.env as Env),
};

/**
 * API composition root for Earn providers.
 *
 * `@sdp/earn` intentionally owns the lightweight catalogue registry so its cron
 * can list every provider without loading a chain SDK. The API owns execution,
 * so it replaces the entries that can move money with their vault-direct
 * supersets and leaves the rest alone. Routes must resolve through this registry
 * when they need provider capabilities.
 */
export const EARN_PROVIDER_CLIENTS: Record<EarnProviderId, EarnVaultProvider> = {
  ...CATALOGUE_PROVIDER_CLIENTS,
};
for (const provider of EARN_PROVIDERS) {
  const client = createEarnExecutionClient(provider, singletonDependencies);
  if (client !== null) EARN_PROVIDER_CLIENTS[provider] = client;
}

export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
