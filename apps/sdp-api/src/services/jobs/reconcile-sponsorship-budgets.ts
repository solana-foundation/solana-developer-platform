import {
  getSponsoredSignatureStatus,
  getSponsoredTransaction,
  sponsoredFinalizedHeight,
} from "@sdp/fee-payment/chain-reads";
import type { SponsorshipProviderConfiguration } from "@sdp/fee-payment/port";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { address, assertIsAddress, assertIsSignature } from "@solana/kit";
import { getDb } from "@/db/client";
import {
  SPONSORSHIP_BREAKER_OPERATOR,
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
  type SponsorshipReconciliationReservation,
  sponsorshipNetworkForCluster,
} from "@/db/repositories/sponsorship-budget.repository";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import { getManagedSponsorshipProviderConfiguration } from "@/services/sponsorship.service";
import { sponsorshipProviderConfigFingerprint } from "@/services/sponsorship-budget.service";
import type { Env } from "@/types/env";

const RECONCILIATION_DELAY_MS = 2 * 60_000;
const RECONCILIATION_BATCH_SIZE = 250;
// About 20 minutes at the 2-minute spacing, far past finality for a transaction that landed.
const FINALITY_WAIT_PASSES = 10;

// Cloud Run recycles provider instances routinely; a config read that fails
// during such a gap must not disable sponsorship on the first miss.
const PROVIDER_CONFIG_READ_ATTEMPTS = 3;
const PROVIDER_CONFIG_RETRY_DELAY_MS = 5_000;

// Per-request admission is already fail-closed while the provider is
// unreachable, so an immediate trip buys no safety and only extends the outage
// past the provider's recovery. Reconciliation skips the tick instead and
// trips only after this many consecutive failed ticks — an operator signal
// for a sustained outage, not a lock for a blip.
const CONSECUTIVE_CONFIG_FAILURES_BEFORE_TRIP = 3;

export const KORA_CONFIG_UNAVAILABLE_BREAKER_REASON =
  "Kora security configuration was unavailable during reconciliation";
const BREAKER_RECOVERY_REASON =
  "Kora security configuration became readable again during reconciliation";

type ReconciliationRepository = Pick<
  SponsorshipBudgetRepository,
  | "listReconciliationCandidates"
  | "recordReconciliationMiss"
  | "settleReservation"
  | "markChargedUnknown"
  | "getReservation"
  | "getGlobalPolicy"
  | "tripGlobalBreaker"
  | "resumeGlobalBreaker"
  | "recordProviderConfigFailure"
  | "resetProviderConfigFailures"
  | "markRedisSettled"
>;
type ReconciliationRedis = Pick<SponsorshipBudgetRedis, "settle" | "syncPolicy">;

type ReconciliationOutcome =
  | "redis_synced"
  | "committed"
  | "charged_unknown"
  | "still_valid"
  | "awaiting_finality"
  | "released";

export interface SponsorshipReconciliationDependencies {
  repository?: ReconciliationRepository;
  budgetRedis?: ReconciliationRedis;
  getTransaction?: typeof getSponsoredTransaction;
  finalizedHeight?: typeof sponsoredFinalizedHeight;
  getSignatureStatus?: typeof getSponsoredSignatureStatus;
  getProviderConfiguration?: () => Promise<SponsorshipProviderConfiguration>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reconcile the open cluster scope's network. Registered once per Environment (a `cluster` Cron
 * Definition): one process can sponsor on both clusters (Earn movements pick the paymaster by
 * cluster), and each network has its own reservations, policies, breaker and Kora, so each
 * registration is its own pass against its own RPC and its own provider configuration.
 *
 * A network is never skipped for lacking a paymaster NOW: reservations outlive
 * configuration. If a cluster's Kora is unwired after transactions reserved
 * against it, those reservations still need settling and a recoverable breaker
 * still needs resetting, so the pass runs, cannot read the provider
 * configuration, and reports that as a failed pass (tripping the breaker after
 * the usual consecutive failures) rather than leaving budget locked in
 * silence. A network with nothing outstanding costs one candidates query.
 *
 * @param env - Process environment.
 * @param dependencies - Test seams for the repository, Redis, chain reads and clock.
 * @returns Resolves once the scope's network has been reconciled.
 */
export async function reconcileSponsorshipBudgets(
  env: Env,
  dependencies: SponsorshipReconciliationDependencies = {}
): Promise<void> {
  await reconcileSponsorshipNetwork(env, currentClusterScope().cluster, dependencies);
}

async function reconcileSponsorshipNetwork(
  env: Env,
  cluster: SolanaCluster,
  dependencies: SponsorshipReconciliationDependencies
): Promise<void> {
  const repository = dependencies.repository ?? new SponsorshipBudgetRepository(getDb(env));
  const budgetRedis = dependencies.budgetRedis ?? new SponsorshipBudgetRedis(env);
  // NOTE: settlement reads Kora's upstream while track-pending-transfers settles the same
  // transaction's payment row on the managed pool. Kept apart on purpose: sponsorship bookkeeping
  // stays off the customer pool. Both are nodes on one genesis-checked cluster, so outcomes
  // converge. A reservation is released only on proof it never landed: the finalized block height
  // is past its stored last valid block height and its signature is absent from history. Every
  // difference that proof cannot settle (slot lag, an early "not found") still resolves toward
  // charged_unknown, which over-counts and never refunds a transaction that landed. Each read
  // resolves the endpoint when called, so a network with nothing outstanding needs none.
  const getTransaction = dependencies.getTransaction ?? getSponsoredTransaction;
  const finalizedHeight = dependencies.finalizedHeight ?? sponsoredFinalizedHeight;
  const getSignatureStatus = dependencies.getSignatureStatus ?? getSponsoredSignatureStatus;
  const now = dependencies.now?.() ?? new Date();
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const updatedBefore = new Date(now.getTime() - RECONCILIATION_DELAY_MS).toISOString();
  const network = sponsorshipNetworkForCluster(cluster);
  const reservations = await repository.listReconciliationCandidates(
    network,
    updatedBefore,
    RECONCILIATION_BATCH_SIZE
  );
  const failures: Error[] = [];
  const outcomes: Record<ReconciliationOutcome, number> = {
    redis_synced: 0,
    committed: 0,
    charged_unknown: 0,
    still_valid: 0,
    awaiting_finality: 0,
    released: 0,
  };

  const globalPolicy = await repository.getGlobalPolicy(network);
  const recoverableTrip = isRecoverableBreakerTrip(globalPolicy);

  if (reservations.length === 0 && !recoverableTrip) {
    logEvent("info", {
      event: "sdp_api_sponsorship_reconciliation_tick",
      network,
      candidates: 0,
      failed: 0,
      batch_saturated: false,
      ...outcomes,
    });
    return;
  }

  const getProviderConfiguration =
    dependencies.getProviderConfiguration ??
    (() => getManagedSponsorshipProviderConfiguration(env));
  let providerConfiguration: SponsorshipProviderConfiguration;
  try {
    providerConfiguration = await readProviderConfiguration(getProviderConfiguration, sleep);
  } catch (error) {
    // With no live reservations there is nothing the breaker protects; the
    // already-tripped policy stays down and the next tick probes again.
    if (reservations.length > 0) {
      await handleProviderConfigFailure(repository, budgetRedis, network);
    }
    throw new Error("Kora security configuration is unavailable", { cause: error });
  }
  await repository.resetProviderConfigFailures(network);

  if (recoverableTrip) {
    const resumed = await repository.resumeGlobalBreaker(
      network,
      KORA_CONFIG_UNAVAILABLE_BREAKER_REASON,
      BREAKER_RECOVERY_REASON
    );
    if (resumed) {
      logEvent("warn", {
        event: "sdp_api_sponsorship_breaker_recovered",
        network,
        source: "reconciliation",
      });
      // A failed sync is repaired by the next admission: reserve() re-syncs
      // every policy from Postgres before touching the Lua counters.
      await budgetRedis.syncPolicy(resumed);
    }
  }

  if (reservations.length === 0) {
    logEvent("info", {
      event: "sdp_api_sponsorship_reconciliation_tick",
      network,
      candidates: 0,
      failed: 0,
      batch_saturated: false,
      ...outcomes,
    });
    return;
  }

  const providerConfigFingerprint = sponsorshipProviderConfigFingerprint(providerConfiguration);

  for (const reservation of reservations) {
    try {
      if (
        reservation.feePayer !== providerConfiguration.signerAddress ||
        reservation.providerConfigFingerprint !== providerConfigFingerprint
      ) {
        await tripBreaker(
          repository,
          budgetRedis,
          reservation.network,
          "Kora signer or security configuration changed during sponsorship reconciliation"
        );
        throw new Error("Kora signer or security configuration does not match the reservation");
      }
      const outcome = await reconcileReservation({
        reservation,
        repository,
        budgetRedis,
        getTransaction,
        finalizedHeight,
        getSignatureStatus,
      });
      outcomes[outcome] += 1;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      getLogger().error(
        { reservation_id: reservation.id, network: reservation.network, error: failure.message },
        "sponsorship reconciliation failed"
      );
    }
  }

  logEvent("info", {
    event: "sdp_api_sponsorship_reconciliation_tick",
    network,
    candidates: reservations.length,
    failed: failures.length,
    batch_saturated: reservations.length === RECONCILIATION_BATCH_SIZE,
    ...outcomes,
  });

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more sponsorship reservations failed reconciliation"
    );
  }
}

async function reconcileReservation(input: {
  reservation: SponsorshipReconciliationReservation;
  repository: ReconciliationRepository;
  budgetRedis: ReconciliationRedis;
  getTransaction: SponsorshipReconciliationDependencies["getTransaction"] & {};
  finalizedHeight: SponsorshipReconciliationDependencies["finalizedHeight"] & {};
  getSignatureStatus: SponsorshipReconciliationDependencies["getSignatureStatus"] & {};
}): Promise<ReconciliationOutcome> {
  const { reservation, repository, budgetRedis } = input;
  if (reservation.status === "committed" || reservation.status === "released") {
    if (reservation.actualLamports === null) {
      throw new Error("Terminal sponsorship reservation omitted actual lamports");
    }
    await syncRedisSettlement(repository, budgetRedis, reservation, reservation.actualLamports);
    return "redis_synced";
  }
  if (!reservation.signature) {
    await persistAmbiguousCharge({
      reservation,
      repository,
      budgetRedis,
      reason: "No signature was durably captured before reconciliation timeout",
      breakerReason: "Signature-less ambiguous reservation lost its durable transition",
      lostTransitionError: "Failed to persist signature-less ambiguous sponsorship outcome",
    });
    return "charged_unknown";
  }

  assertIsSignature(reservation.signature);
  assertIsAddress(reservation.feePayer);
  const transaction = await input.getTransaction(reservation.signature);
  if (transaction) {
    const transactionFeePayer = address(transaction.accountKeys[0]);
    if (transactionFeePayer !== reservation.feePayer) {
      logEvent("error", {
        event: "sdp_api_sponsorship_settlement_fee_payer_mismatch",
        network: reservation.network,
        reservation_id: reservation.id,
        signature: reservation.signature,
        reserved_fee_payer: reservation.feePayer,
        transaction_fee_payer: transactionFeePayer,
      });
      await persistAmbiguousCharge({
        reservation,
        repository,
        budgetRedis,
        reason: "Finalized transaction names a different fee payer than the reservation",
        breakerReason: "Fee-payer-mismatched reservation lost its durable transition",
        lostTransitionError: "Failed to persist fee-payer-mismatched sponsorship outcome",
      });
      return "charged_unknown";
    }
    const actualLamports = feePayerSpendLamports(transaction.preBalances, transaction.postBalances);
    if (actualLamports > reservation.reservedLamports) {
      await tripBreaker(
        repository,
        budgetRedis,
        reservation.network,
        `Actual sponsorship spend ${actualLamports} exceeded reservation ${reservation.reservedLamports}`
      );
    }
    await settleDurably(repository, budgetRedis, reservation, "committed", actualLamports);
    return "committed";
  }

  // The NULL arm exists only until the contract migration deletes rows admitted before 0159.
  if (reservation.lastValidBlockHeight === null) {
    await persistAmbiguousCharge({
      reservation,
      repository,
      budgetRedis,
      reason: "Reservation predates the stored last valid block height",
      breakerReason: "Pre-height reservation lost its durable transition",
      lostTransitionError: "Failed to retain pre-height sponsorship charge",
    });
    return "charged_unknown";
  }
  const height = await input.finalizedHeight();
  if (height.blockHeight <= reservation.lastValidBlockHeight) return "still_valid";
  // Expiry is proven by the finalized block height passing the reservation's stored upper bound on
  // the transaction's last valid block height. The status is read from a node at least as current
  // as that height read (minContextSlot). Deployment invariant: Kora's upstream serves full
  // transaction history (an indexer-backed RPC), however late reconciliation runs. An absent
  // status is then proof the transaction never landed, not a lagging or pruned record of one
  // that did.
  const status = await input.getSignatureStatus(reservation.signature, height.absoluteSlot);
  if (status !== null) {
    if (reservation.missCount >= FINALITY_WAIT_PASSES) {
      await persistAmbiguousCharge({
        reservation,
        repository,
        budgetRedis,
        reason: "Signature landed but never finalized within the wait window",
        breakerReason: "Unfinalized landed reservation lost its durable transition",
        lostTransitionError: "Failed to retain unfinalized landed sponsorship charge",
      });
      return "charged_unknown";
    }
    await repository.recordReconciliationMiss(
      reservation.id,
      reservation.attempt,
      reservation.missCount
    );
    return "awaiting_finality";
  }
  await settleDurably(
    repository,
    budgetRedis,
    reservation,
    "released",
    0,
    "Finalized block height passed the last valid block height and the signature is absent from history"
  );
  return "released";
}

function feePayerSpendLamports(
  preBalances: readonly bigint[] | undefined,
  postBalances: readonly bigint[] | undefined
): number {
  const before = preBalances?.[0];
  const after = postBalances?.[0];
  if (before === undefined || after === undefined) {
    throw new Error("Finalized transaction omitted fee-payer balance data");
  }
  const delta = before > after ? before - after : 0n;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Fee-payer balance delta exceeds JavaScript safe integer range");
  }
  return Number(delta);
}

async function settleDurably(
  repository: ReconciliationRepository,
  budgetRedis: ReconciliationRedis,
  reservation: SponsorshipReconciliationReservation,
  status: "committed" | "released",
  actualLamports: number,
  reason?: string
): Promise<void> {
  const settled = await repository.settleReservation(
    reservation.id,
    reservation.attempt,
    status,
    actualLamports,
    reason
  );
  if (!settled) return;
  await syncRedisSettlement(repository, budgetRedis, reservation, actualLamports);
}

async function syncRedisSettlement(
  repository: ReconciliationRepository,
  budgetRedis: ReconciliationRedis,
  reservation: SponsorshipReconciliationReservation,
  actualLamports: number
): Promise<void> {
  try {
    await budgetRedis.settle({
      network: reservation.network,
      organizationId: reservation.organizationId,
      projectId: reservation.projectId,
      hourBucket: reservation.hourBucket,
      dayBucket: reservation.dayBucket,
      reservationId: reservation.id,
      attempt: reservation.attempt,
      reservedLamports: reservation.reservedLamports,
      actualLamports,
      detectMissingReservation: true,
    });
    const persisted = await repository.markRedisSettled(reservation.id, reservation.attempt);
    if (!persisted) throw new Error("Redis settlement lost its durable reservation ownership");
  } catch (error) {
    await tripBreaker(
      repository,
      budgetRedis,
      reservation.network,
      "Redis settlement failed after durable ledger settlement"
    );
    throw error;
  }
}

function isRecoverableBreakerTrip(policy: SponsorshipBudgetPolicy | null): boolean {
  // Only trips caused by a transient config-read failure self-heal. Operator
  // kills and integrity trips (overspend, lost durable transitions) stay down
  // until a human resumes them.
  return (
    policy !== null &&
    !policy.enabled &&
    policy.updatedBy === SPONSORSHIP_BREAKER_OPERATOR &&
    policy.updateReason === KORA_CONFIG_UNAVAILABLE_BREAKER_REASON
  );
}

async function readProviderConfiguration(
  getProviderConfiguration: () => Promise<SponsorshipProviderConfiguration>,
  sleep: (ms: number) => Promise<void>
): Promise<SponsorshipProviderConfiguration> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_CONFIG_READ_ATTEMPTS; attempt += 1) {
    try {
      return await getProviderConfiguration();
    } catch (error) {
      lastError = error;
      if (attempt < PROVIDER_CONFIG_READ_ATTEMPTS) {
        await sleep(PROVIDER_CONFIG_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function handleProviderConfigFailure(
  repository: ReconciliationRepository,
  budgetRedis: ReconciliationRedis,
  network: SponsorshipNetwork
): Promise<void> {
  const consecutiveFailures = await repository.recordProviderConfigFailure(network);
  if (consecutiveFailures >= CONSECUTIVE_CONFIG_FAILURES_BEFORE_TRIP) {
    await tripBreaker(repository, budgetRedis, network, KORA_CONFIG_UNAVAILABLE_BREAKER_REASON, {
      recoverable: true,
    });
    return;
  }
  logEvent("warn", {
    event: "sdp_api_sponsorship_config_read_failed",
    network,
    consecutive_failures: consecutiveFailures,
    trip_threshold: CONSECUTIVE_CONFIG_FAILURES_BEFORE_TRIP,
  });
}

async function tripBreaker(
  repository: ReconciliationRepository,
  budgetRedis: ReconciliationRedis,
  network: SponsorshipNetwork,
  reason: string,
  options: { recoverable?: boolean } = {}
): Promise<void> {
  const policy = await repository.tripGlobalBreaker(network, reason, options);
  logEvent("error", {
    event: "sdp_api_sponsorship_breaker_tripped",
    network,
    reason,
    already_tripped: policy === null,
    source: "reconciliation",
  });
  if (policy) await budgetRedis.syncPolicy(policy);
}

async function persistAmbiguousCharge(input: {
  reservation: SponsorshipReconciliationReservation;
  repository: ReconciliationRepository;
  budgetRedis: ReconciliationRedis;
  reason: string;
  breakerReason: string;
  lostTransitionError: string;
}): Promise<void> {
  const { reservation, repository, budgetRedis } = input;
  if (await repository.markChargedUnknown(reservation.id, reservation.attempt, input.reason)) {
    return;
  }
  const current = await repository.getReservation(reservation.id);
  const concurrentlyResolved =
    current !== null &&
    (current.attempt !== reservation.attempt ||
      current.status === "charged_unknown" ||
      current.status === "committed" ||
      current.status === "released");
  if (concurrentlyResolved) {
    return;
  }
  await tripBreaker(repository, budgetRedis, reservation.network, input.breakerReason);
  throw new Error(input.lostTransitionError);
}
