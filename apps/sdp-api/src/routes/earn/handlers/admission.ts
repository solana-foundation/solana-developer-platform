import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import { isClusterFundableInEnvironment } from "@sdp/earn/support";
import type { SdpEnvironment } from "@sdp/types";
import { type EarnProviderId, earnDepositStyle } from "@sdp/types/provider-access";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { getAuth } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import { type AppContext, resolveSdpEnvironment } from "../context";

/**
 * The ONE money-in admission predicate for an Earn catalogue row.
 *
 * Both money-in paths reach this: `POST /programs` (custodial allocations) and
 * `POST /vault-deposits` (non-custodial). Before it existed the two disagreed,
 * and the disagreement was not theoretical — the vault path resolved its row
 * with a bare `getStrategyById` and so would happily fund a `paused` or
 * `deprecated` strategy that `POST /programs` refused. `paused` is the operator
 * stop switch: the hourly sync goes out of its way NOT to clobber it and the
 * delist pass deliberately leaves such rows behind, precisely so a human can
 * halt deposits during an exploit or a depeg. A second money-in path that
 * ignored it made that switch a suggestion.
 *
 * ── What this deliberately does NOT check ───────────────────────────────────
 * Browse policy — hidden terms, curation, provider surfacing. Those live in
 * `handlers/strategies.ts` and gate what a reader SEES, not what an existing
 * customer may fund; see routes/earn/CLAUDE.md. Surfacing and entitlement are
 * separate, earlier gates with their own error codes, because "SDP does not
 * offer this" and "this instrument is halted" are different answers.
 */
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

/**
 * The ONE vault money-in gate sequence, shared by every handler that commits a
 * strategy to the vault-deposit path: `POST /vault-deposits` (moves money now)
 * and `PUT /button-configurations/current` (persists a strategy the deposit
 * route must later accept). Runs, in order: deposit-style shape, provider
 * registration, surfacing, entitlement/credentials, catalogue admission.
 * A second copy is a second thing that can drift toward permissive — when a
 * gate is added or production opens, both callers move together.
 *
 * Strategy RESOLUTION stays with the caller on purpose: the deposit route
 * resolves bare-by-id (browse policy never gates money), while the builder
 * resolves through `requireEarnStrategy` (a hidden row must not be offered to
 * a NEW configuration).
 */
export async function assertVaultDepositAdmissible(
  c: AppContext,
  strategy: EarnStrategyRow
): Promise<EarnProviderId> {
  const environment = resolveSdpEnvironment(c);

  if (earnDepositStyle(strategy.provider) !== "vault_direct") {
    throw badRequest(
      `${strategy.provider} is a custodial provider; use POST /v1/earn/programs instead.`
    );
  }
  if (!isEarnProviderId(strategy.provider)) {
    throw providerNotConfigured(
      `Earn provider ${strategy.provider} is not available in this deployment`
    );
  }
  const provider = strategy.provider;

  assertEarnProviderSurfaced(provider);
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    getAuth(c).organizationId,
    "earn",
    provider,
    environment === "sandbox"
  );
  assertStrategyDepositable(strategy, environment);

  return provider;
}

/**
 * Non-throwing form, for callers filtering a page of rows rather than admitting
 * one named row. Keeps the two uses on the same definition.
 */
export function isStrategyDepositable(
  strategy: EarnStrategyRow,
  environment: SdpEnvironment
): boolean {
  try {
    assertStrategyDepositable(strategy, environment);
    return true;
  } catch {
    return false;
  }
}
