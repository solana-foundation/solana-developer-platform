import type { SponsorshipProviderConfiguration } from "@sdp/payments/fee-payment";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertIsBlockhash, assertIsSignature, type Blockhash, type Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  SPONSORSHIP_BREAKER_OPERATOR,
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
  type SponsorshipReconciliationReservation,
} from "@/db/repositories/sponsorship-budget.repository";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import type { Env } from "@/types/env";
import { getManagedSponsorshipProviderConfiguration } from "../sponsorship.service";
import { sponsorshipProviderConfigFingerprint } from "../sponsorship-budget.service";

const RECONCILIATION_DELAY_MS = 2 * 60_000;
const RECONCILIATION_BATCH_SIZE = 250;

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
  | "awaiting_expiry";

export interface SponsorshipReconciliationDependencies {
  repository?: ReconciliationRepository;
  budgetRedis?: ReconciliationRedis;
  getTransaction?: (
    signature: Signature
  ) => Promise<Awaited<ReturnType<typeof solanaRpc.getTransaction>>>;
  isBlockhashValid?: (blockhash: Blockhash) => Promise<boolean>;
  getProviderConfiguration?: () => Promise<SponsorshipProviderConfiguration>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export async function reconcileSponsorshipBudgets(
  env: Env,
  dependencies: SponsorshipReconciliationDependencies = {}
): Promise<void> {
  const repository = dependencies.repository ?? new SponsorshipBudgetRepository(getDb(env));
  const budgetRedis = dependencies.budgetRedis ?? new SponsorshipBudgetRedis(env);
  const rpc =
    dependencies.getTransaction || dependencies.isBlockhashValid ? null : solanaRpc.createRpc(env);
  const getTransaction =
    dependencies.getTransaction ??
    ((signature: Signature) => solanaRpc.getTransaction(assertRpc(rpc), signature));
  const isBlockhashValid =
    dependencies.isBlockhashValid ??
    ((blockhash: Blockhash) => solanaRpc.isBlockhashValid(assertRpc(rpc), blockhash));
  const now = dependencies.now?.() ?? new Date();
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const updatedBefore = new Date(now.getTime() - RECONCILIATION_DELAY_MS).toISOString();
  const network = env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
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
    awaiting_expiry: 0,
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
        isBlockhashValid,
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
  isBlockhashValid: SponsorshipReconciliationDependencies["isBlockhashValid"] & {};
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
  const transaction = await input.getTransaction(reservation.signature);
  if (transaction) {
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

  assertIsBlockhash(reservation.recentBlockhash);
  if (await input.isBlockhashValid(reservation.recentBlockhash)) return "still_valid";
  if (reservation.missCount === 0) {
    await repository.recordReconciliationMiss(reservation.id, reservation.attempt, 0);
    return "awaiting_expiry";
  }
  await persistAmbiguousCharge({
    reservation,
    repository,
    budgetRedis,
    reason: "Signature absent after blockhash expiry on two reconciliation passes",
    breakerReason: "Ambiguous unconfirmed reservation lost its durable transition",
    lostTransitionError: "Failed to retain ambiguous unconfirmed sponsorship charge",
  });
  return "charged_unknown";
}

function feePayerSpendLamports(
  preBalances: readonly bigint[] | undefined,
  postBalances: readonly bigint[] | undefined
): number {
  const before = preBalances?.[0];
  const after = postBalances?.[0];
  if (before === undefined || after === undefined) {
    throw new Error("Confirmed transaction omitted fee-payer balance data");
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

function assertRpc(rpc: solanaRpc.SolanaRpc | null): solanaRpc.SolanaRpc {
  if (!rpc) throw new Error("A Solana RPC dependency is required for sponsorship reconciliation");
  return rpc;
}
