import type { SponsorshipProviderConfiguration } from "@sdp/payments/fee-payment";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertIsBlockhash, assertIsSignature, type Blockhash, type Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
  type SponsorshipReconciliationReservation,
} from "@/db/repositories/sponsorship-budget.repository";
import { getLogger } from "@/runtime/logger";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import type { Env } from "@/types/env";
import { getManagedSponsorshipProviderConfiguration } from "../sponsorship.service";
import { sponsorshipProviderConfigFingerprint } from "../sponsorship-budget.service";

const RECONCILIATION_DELAY_MS = 2 * 60_000;
const RECONCILIATION_BATCH_SIZE = 250;

type ReconciliationRepository = Pick<
  SponsorshipBudgetRepository,
  | "listReconciliationCandidates"
  | "recordReconciliationMiss"
  | "settleReservation"
  | "markChargedUnknown"
  | "getReservation"
  | "tripGlobalBreaker"
  | "markRedisSettled"
>;
type ReconciliationRedis = Pick<SponsorshipBudgetRedis, "settle" | "syncPolicy">;

export interface SponsorshipReconciliationDependencies {
  repository?: ReconciliationRepository;
  budgetRedis?: ReconciliationRedis;
  getTransaction?: (
    signature: Signature
  ) => Promise<Awaited<ReturnType<typeof solanaRpc.getTransaction>>>;
  isBlockhashValid?: (blockhash: Blockhash) => Promise<boolean>;
  getProviderConfiguration?: () => Promise<SponsorshipProviderConfiguration>;
  now?: () => Date;
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
  const updatedBefore = new Date(now.getTime() - RECONCILIATION_DELAY_MS).toISOString();
  const network = env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
  const reservations = await repository.listReconciliationCandidates(
    network,
    updatedBefore,
    RECONCILIATION_BATCH_SIZE
  );
  const failures: Error[] = [];

  if (reservations.length === 0) return;

  let providerConfiguration: SponsorshipProviderConfiguration;
  try {
    providerConfiguration = await (dependencies.getProviderConfiguration?.() ??
      getManagedSponsorshipProviderConfiguration(env));
  } catch (error) {
    await tripBreaker(
      repository,
      budgetRedis,
      network,
      "Kora security configuration was unavailable during reconciliation"
    );
    throw new Error("Kora security configuration is unavailable", { cause: error });
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
      await reconcileReservation({
        reservation,
        repository,
        budgetRedis,
        getTransaction,
        isBlockhashValid,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      getLogger().error(
        { reservation_id: reservation.id, network: reservation.network, error: failure.message },
        "sponsorship reconciliation failed"
      );
    }
  }

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
}): Promise<void> {
  const { reservation, repository, budgetRedis } = input;
  if (reservation.status === "committed" || reservation.status === "released") {
    if (reservation.actualLamports === null) {
      throw new Error("Terminal sponsorship reservation omitted actual lamports");
    }
    await syncRedisSettlement(repository, budgetRedis, reservation, reservation.actualLamports);
    return;
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
    return;
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
    return;
  }

  assertIsBlockhash(reservation.recentBlockhash);
  if (await input.isBlockhashValid(reservation.recentBlockhash)) return;
  if (reservation.missCount === 0) {
    await repository.recordReconciliationMiss(reservation.id, reservation.attempt, 0);
    return;
  }
  await persistAmbiguousCharge({
    reservation,
    repository,
    budgetRedis,
    reason: "Signature absent after blockhash expiry on two reconciliation passes",
    breakerReason: "Ambiguous unconfirmed reservation lost its durable transition",
    lostTransitionError: "Failed to retain ambiguous unconfirmed sponsorship charge",
  });
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

async function tripBreaker(
  repository: ReconciliationRepository,
  budgetRedis: ReconciliationRedis,
  network: SponsorshipNetwork,
  reason: string
): Promise<void> {
  const policy = await repository.tripGlobalBreaker(network, reason);
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
