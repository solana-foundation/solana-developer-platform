import { EARN_PROVIDER_CLIENTS as CATALOGUE_PROVIDER_CLIENTS, isEarnProviderId } from "@sdp/earn";
import { providerNotConfigured } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultProvider } from "@sdp/earn/types";
import {
  assertNotPortfolioProvider as assertHastraNotPortfolioProvider,
  HastraVaultDirectClient,
} from "@sdp/hastra/client";
import {
  assertJupiterLendNotPortfolioProvider,
  JupiterLendVaultDirectClient,
} from "@sdp/jupiter-lend/client";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino/client";
import {
  assertNotPortfolioProvider as assertOndoNotPortfolioProvider,
  OndoVaultDirectClient,
} from "@sdp/ondo/client";
import type { EarnProviderId } from "@sdp/types/provider-access";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  assertNotPortfolioProvider as assertVedaNotPortfolioProvider,
  VedaVaultDirectClient,
} from "@sdp/veda/client";
import {
  assertWisdomTreeNotPortfolioProvider,
  WisdomTreeVaultDirectClient,
} from "@sdp/wisdomtree/client";
import {
  assertClusterEndpoint,
  earnPoolNotConfigured,
  earnProviderEndpointUrls,
} from "@/services/earn/cluster-rpc";
import type { Env } from "@/types/env";
import { createHastraSwapPort } from "./earn/hastra-swap-port";
import { createOndoSwapPort } from "./earn/ondo-swap-port";
import { createVaultDeadline } from "./earn/vault-deadline";

/**
 * The preferred endpoint of the request's cluster pool, proven before the
 * singleton provider performs any chain work. The cluster comes from the
 * request-scoped runtime, so one API process serves both SDP environments.
 */
async function resolveProvenRpcUrl(
  _ctx: EarnRuntimeContext,
  cluster: SolanaCluster
): Promise<string> {
  const [rpcUrl] = earnProviderEndpointUrls(cluster);
  if (rpcUrl === undefined) throw earnPoolNotConfigured(cluster);
  await assertClusterEndpoint(cluster, rpcUrl);
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
const jupiterLend = new JupiterLendVaultDirectClient(resolveProvenRpcUrl, runVaultOperation);
assertJupiterLendNotPortfolioProvider(jupiterLend);

const veda = new VedaVaultDirectClient(resolveProvenRpcUrl, runVaultOperation);
assertVedaNotPortfolioProvider(veda);
const wisdomtree = new WisdomTreeVaultDirectClient(resolveProvenRpcUrl, runVaultOperation);
assertWisdomTreeNotPortfolioProvider(wisdomtree);

// The swap port is resolved per request from the runtime context (the API
// constructs `ctx.env` from `Env`), because these are process singletons and
// the Jupiter credential is request-environment state, same as the RPC URL.
const ondo = new OndoVaultDirectClient(resolveProvenRpcUrl, runVaultOperation, (ctx) =>
  createOndoSwapPort(ctx.env as unknown as Env)
);
assertOndoNotPortfolioProvider(ondo);
const hastra = new HastraVaultDirectClient(resolveProvenRpcUrl, runVaultOperation, (ctx) =>
  createHastraSwapPort(ctx.env as unknown as Env)
);
assertHastraNotPortfolioProvider(hastra);

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
  jupiter_lend: jupiterLend,
  veda,
  ondo,
  hastra,
  wisdomtree,
} as const satisfies Record<EarnProviderId, EarnVaultProvider>;

export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
