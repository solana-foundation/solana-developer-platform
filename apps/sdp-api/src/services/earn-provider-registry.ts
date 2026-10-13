import {
  EARN_PROVIDER_CLIENTS as CATALOGUE_PROVIDER_CLIENTS,
  isEarnProviderId,
  providerNotConfigured,
} from "@sdp/earn";
import type { EarnVaultProvider } from "@sdp/earn/types";
import {
  assertNotPortfolioProvider as assertHastraNotPortfolioProvider,
  HastraVaultDirectClient,
} from "@sdp/hastra";
import {
  assertJupiterLendNotPortfolioProvider,
  JupiterLendVaultDirectClient,
} from "@sdp/jupiter-lend";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "@sdp/kamino";
import {
  assertNotPortfolioProvider as assertOndoNotPortfolioProvider,
  OndoVaultDirectClient,
} from "@sdp/ondo";
import type { EarnProviderId } from "@sdp/types";
import {
  assertNotPortfolioProvider as assertVedaNotPortfolioProvider,
  VedaVaultDirectClient,
} from "@sdp/veda";
import { assertWisdomTreeNotPortfolioProvider, WisdomTreeVaultDirectClient } from "@sdp/wisdomtree";
import type { Env } from "@/types/env";
import { createHastraSwapPort } from "./earn/hastra-swap-port";
import { createOndoSwapPort } from "./earn/ondo-swap-port";
import { createVaultDeadline } from "./earn/vault-deadline";

/** One fresh deadline per operation, since these clients are process singletons. */
function runVaultOperation<T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
): Promise<T> {
  const deadline = createVaultDeadline();
  return deadline.run(label, () => operation(() => deadline.assertActive(label)));
}

const kamino = new KaminoVaultDirectClient(runVaultOperation);
assertNotPortfolioProvider(kamino);
const jupiterLend = new JupiterLendVaultDirectClient(runVaultOperation);
assertJupiterLendNotPortfolioProvider(jupiterLend);

const veda = new VedaVaultDirectClient(runVaultOperation);
assertVedaNotPortfolioProvider(veda);
const wisdomtree = new WisdomTreeVaultDirectClient(runVaultOperation);
assertWisdomTreeNotPortfolioProvider(wisdomtree);

// The swap port is resolved per request from the runtime context (the API
// constructs `ctx.env` from `Env`), because these are process singletons and
// the Jupiter credential is request-environment state.
const ondo = new OndoVaultDirectClient(runVaultOperation, (ctx) =>
  createOndoSwapPort(ctx.env as unknown as Env)
);
assertOndoNotPortfolioProvider(ondo);
const hastra = new HastraVaultDirectClient(runVaultOperation, (ctx) =>
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
