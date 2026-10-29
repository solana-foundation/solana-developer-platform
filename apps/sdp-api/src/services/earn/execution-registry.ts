import {
  supportsVaultDirect,
  supportsVaultParRedemption,
  supportsVaultQueuedWithdraw,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import type {
  EarnVaultDirectProvider,
  EarnVaultParRedemptionProvider,
  EarnVaultProvider,
  EarnVaultQueuedWithdrawProvider,
  EarnVaultWithdrawProvider,
} from "@sdp/earn/types";
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
import {
  assertNotPortfolioProvider as assertVedaNotPortfolioProvider,
  VedaVaultDirectClient,
} from "@sdp/veda/client";
import {
  assertWisdomTreeNotPortfolioProvider,
  WisdomTreeVaultDirectClient,
} from "@sdp/wisdomtree/client";
import { isEarnHastraDexExitConfigured } from "@/lib/feature-flags";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { assertClusterEndpoint } from "./cluster-rpc";
import { createHastraSwapPort } from "./hastra-swap-port";
import { createOndoSwapPort } from "./ondo-swap-port";
import type { VaultDeadline } from "./vault-deadline";
import { createVaultRpcFailover } from "./vault-rpc-failover";

/**
 * Which providers this deployment can EXECUTE for, as opposed to merely
 * catalogue.
 *
 * `EARN_PROVIDER_CLIENTS` in `@sdp/earn` stays the catalogue registry — it is
 * what the hourly sync resolves through, and it must remain free of chain SDKs
 * so that cron keeps its small dependency surface. This overlay is consulted
 * only by routes that move money, and it is the ONE place a provider id is
 * mapped to an executing client. Everything downstream narrows with
 * `supportsVaultDirect`, never an id check.
 *
 * Every client gets its endpoints from the open cluster scope's managed pool
 * (`./cluster-rpc`), one pinned per operation attempt, each proven to serve
 * that cluster before the provider touches it.
 */

/**
 * Build the executing client for a provider, or `null` when this deployment has
 * none. Fail-closed: an unrecognized provider id answers null rather than
 * throwing, so a row written by a newer deploy degrades to "cannot execute"
 * instead of 500ing a read that happens to touch it.
 */
export function resolveEarnExecutionClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultProvider | null {
  // Construction stays synchronous and I/O-free for every branch. The clients
  // await this resolver only when a chain method is invoked, so an idempotent
  // replay can return from durable state during an RPC outage.
  const { resolve: provenRpcUrl, run: runOperation } = createVaultRpcFailover(
    deadline,
    assertClusterEndpoint
  );

  if (provider === "kamino") {
    const client = new KaminoVaultDirectClient(provenRpcUrl, runOperation);
    assertNotPortfolioProvider(client);
    return instrumentVendorPort("kamino", client);
  }
  if (provider === "jupiter_lend") {
    const client = new JupiterLendVaultDirectClient(provenRpcUrl, runOperation);
    assertJupiterLendNotPortfolioProvider(client);
    return instrumentVendorPort("jupiter_lend", client);
  }
  if (provider === "veda") {
    const client = new VedaVaultDirectClient(provenRpcUrl, runOperation);
    assertVedaNotPortfolioProvider(client);
    return instrumentVendorPort("veda", client);
  }
  if (provider === "ondo") {
    const client = new OndoVaultDirectClient(provenRpcUrl, runOperation, () =>
      createOndoSwapPort(env)
    );
    assertOndoNotPortfolioProvider(client);
    return instrumentVendorPort("ondo", client);
  }
  if (provider === "hastra") {
    const client = new HastraVaultDirectClient(provenRpcUrl, runOperation, () =>
      createHastraSwapPort(env)
    );
    assertHastraNotPortfolioProvider(client);
    return instrumentVendorPort("hastra", client);
  }
  if (provider === "wisdomtree") {
    const client = new WisdomTreeVaultDirectClient(provenRpcUrl, runOperation);
    assertWisdomTreeNotPortfolioProvider(client);
    return instrumentVendorPort("wisdomtree", client);
  }
  return null;
}

/** The executing client narrowed to the vault-direct capability, or null. */
export function resolveVaultDirectClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultDirectProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultDirect(client) ? client : null;
}

/**
 * The executing client narrowed to the vault-WITHDRAW capability, or null.
 *
 * Null means "SDP cannot build this provider's instant exit" (501 at the
 * route), never that the caller lacks permission to withdraw. Most providers
 * narrow on capability alone. Hastra additionally applies its dedicated DEX
 * rollout gate while the independent par-redemption escape hatch remains on.
 * No money-in availability, surfacing, or entitlement gate reaches this path.
 */
export function resolveVaultWithdrawClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultWithdrawProvider | null {
  // Hastra always retains its separate operator-redemption capability below.
  // This opt-in controls only admission to NEW Jupiter quote/build work; it is
  // deliberately checked here so every custody and external-wallet entry
  // point, plus withdrawal-options discovery, agrees on the default par-only
  // posture.
  if (provider === "hastra" && !isEarnHastraDexExitConfigured(env)) return null;

  return resolveRecordedVaultWithdrawClient(env, provider, deadline);
}

/**
 * Resolve the builder capability that produced an already-recorded withdrawal.
 *
 * This deliberately bypasses only live rollout admission. Reconciliation must
 * preserve the settlement semantics of durable Hastra DEX rows after an
 * operator disables new quotes/builds; unknown and catalogue-only providers
 * still return null and therefore retain the reconciler's fail-closed path.
 */
export function resolveRecordedVaultWithdrawClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultWithdrawProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultWithdraw(client) ? client : null;
}

/** The executing client narrowed to the complete asynchronous queue lifecycle. */
export function resolveVaultQueuedWithdrawClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultQueuedWithdrawProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultQueuedWithdraw(client) ? client : null;
}

/** The executing client narrowed to Hastra-style operator par redemption. */
export function resolveVaultParRedemptionClient(
  env: Env,
  provider: string,
  deadline: VaultDeadline
): EarnVaultParRedemptionProvider | null {
  const client = resolveEarnExecutionClient(env, provider, deadline);
  if (!client) return null;
  return supportsVaultParRedemption(client) ? client : null;
}
