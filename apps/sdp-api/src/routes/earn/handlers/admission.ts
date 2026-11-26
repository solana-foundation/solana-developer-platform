import { isEarnProviderId } from "@sdp/earn";
import { providerNotConfigured } from "@sdp/earn/errors";
import { isClusterFundableInEnvironment } from "@sdp/earn/support";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type EarnProviderId,
  earnDepositStyle,
  isVaultDirectDepositEnabled,
} from "@sdp/types/provider-access";
import { getDb } from "@/db/client";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { badRequest, forbidden } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";
import { assertVaultExposureWithinCap } from "@/services/earn/vault-exposure";
import {
  assertProjectProviderAdmitted,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

/** Shared admission for catalogue status, cluster and provider deposit capability. */
export function assertStrategyDepositable(
  strategy: EarnStrategyRow,
  environment: SdpEnvironment
): void {
  if (strategy.environment !== environment) {
    // Phrased as "not found" upstream; reaching here means a caller crossed
    // project environments with a valid id from the other one.
    throw badRequest(`Strategy ${strategy.id} does not belong to this ${environment} project.`);
  }

  if (strategy.status !== "active") {
    throw badRequest(
      `Strategy ${strategy.id} is ${strategy.status} and cannot accept new deposits. ` +
        "An operator pauses a strategy to stop money going in — existing positions are unaffected.",
      { strategyId: strategy.id, status: strategy.status }
    );
  }

  // The single fundability rule. Do NOT re-derive the cluster comparison here
  // or anywhere else (@sdp/earn support.ts): a second copy is a second thing
  // that can drift toward permissive.
  if (!isClusterFundableInEnvironment(strategy.host_cluster, environment)) {
    throw badRequest(
      `This strategy lives on ${strategy.host_cluster}, which is not fundable from a ${environment} project.`,
      { strategyId: strategy.id, hostCluster: strategy.host_cluster, environment }
    );
  }
}

/** Re-admit a recorded strategy before starting asynchronous custody approval. */
export async function assertRecordedStrategyDepositAdmitted(
  env: Env,
  scope: { organizationId: string; projectId: string },
  strategy: EarnStrategyRow
): Promise<void> {
  const { environment } = currentClusterScope();
  assertVaultDirectDepositStyle(strategy.provider);
  if (!isEarnProviderId(strategy.provider))
    throw providerNotConfigured("Strategy provider is unavailable");
  assertVaultDepositEnvironmentOpen(environment, strategy.provider);
  await assertProjectProviderAdmitted(env, getDb(env), scope, {
    family: "earn",
    provider: strategy.provider,
  });
  assertStrategyDepositable(strategy, environment);
}

/**
 * Whether `provider` takes NEW vault deposits from a project in `environment`:
 * the environment's cluster must carry one of the provider's deployments
 * (`EARN_PROVIDER_DEPLOYED_CLUSTERS` in @sdp/types). A mainnet vault is
 * therefore depositable from a production project only, whichever provider
 * fronts it. The dashboard reads the same predicate, so it never advertises
 * an action this refuses. Exits never call this (ADR 0002).
 */
function assertVaultDepositEnvironmentOpen(
  environment: SdpEnvironment,
  provider: EarnProviderId
): void {
  if (!isVaultDirectDepositEnabled(environment, provider)) {
    throw forbidden(
      `Vault deposits for ${provider} are not available from a ${environment} project.`
    );
  }
}

/**
 * The vault-deposit shape: a custodial provider reaching a vault route would
 * silently skip its wallet-provisioning model. It depends on the provider
 * alone, so the custody deposit checks it before its replay lookup.
 */
export function assertVaultDirectDepositStyle(provider: string): void {
  if (earnDepositStyle(provider) !== "vault_direct") {
    throw badRequest(`${provider} does not support strategy deposits.`);
  }
}

/**
 * Shared money-in admission for strategy preparation and execution adapters.
 * Runs in order: deposit-style shape, provider registration, environment capability,
 * the project provider rule, catalogue admission,
 * and LAST, when the caller passes the deposit `amount`, the SDP-wide vault
 * exposure cap (ADR 0004 layer 1, `services/earn/vault-exposure.ts`). Keep it shared: a second copy
 * is a second thing that can drift toward permissive.
 *
 * The custody deposit runs it in its request gate's `admit`, after the replay
 * lookup, so a same-key retry of a recorded deposit is answered from its row
 * whatever these gates say now (ADR 0009).
 *
 * The cap runs last on purpose: it is the only step that reads the ledger,
 * and a caller refused by a cheaper gate should hear that reason, not "the
 * vault is full". Omitting `amount` skips the cap; only callers that are not
 * about to move money may do that (the deposit preview, which reports the cap
 * as a blocking issue instead), and a new money-in caller must pass it.
 *
 * Money OUT never reaches this function (ADR 0002): withdrawals take none of
 * these gates, the exposure cap included. A vault over its cap is exit-only,
 * the same posture as `paused`.
 *
 * Strategy RESOLUTION stays with the caller on purpose: the deposit route
 * resolves bare-by-id (browse policy never gates money).
 */
export async function assertVaultDepositAdmissible(
  c: AppContext,
  strategy: EarnStrategyRow,
  amount?: string
): Promise<EarnProviderId> {
  const { environment } = currentClusterScope();

  assertVaultDirectDepositStyle(strategy.provider);
  if (!isEarnProviderId(strategy.provider)) {
    throw providerNotConfigured(
      `Earn provider ${strategy.provider} is not available in this deployment`
    );
  }
  const provider = strategy.provider;

  assertVaultDepositEnvironmentOpen(environment, provider);
  await assertProviderAvailable(c, { family: "earn", provider });
  assertStrategyDepositable(strategy, environment);

  if (amount !== undefined) {
    // Deposits only. The withdrawal handlers never call this function, and
    // must not start to: refusing an exit over a platform cap traps funds
    // (ADR 0002), which is the one thing no cap may do.
    await assertVaultExposureWithinCap(c, strategy, amount);
  }

  return provider;
}
