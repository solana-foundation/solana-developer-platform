import {
  isActivatingRecurringPaymentStatus,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
  recurringPaymentInFlightLifecycleOperation,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  type CollectibleRecurringPaymentRow,
  createPostgresPaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentRow,
  type RecoverableCollectionRecurringPaymentRow,
} from "@/db/repositories";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { AppError, conflict, internalError } from "@/lib/errors";
import {
  assertMoneyStartAdmitted,
  checkMoneyStart,
  type MoneyAdmissionScope,
  MoneyMovementRefusedError,
  type MoneyStartContext,
} from "@/lib/money-admission";
import { getLogger } from "@/runtime/logger";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import {
  activateRecurringPayment,
  cancelRecurringPayment,
  collectRecurringPayment,
  journalAutomatedCollectionFailure,
  resumeRecurringPayment,
  skipRefusedRecurringCollectionPeriod,
} from "@/services/payments/recurring-payments";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

// Rows are independent: collection, activation, and lifecycle recovery each
// claim their recurring payment under a row lock before touching the chain.
// Batches fan out per organization because policy velocity sums (spending
// limits) are org-scoped and only count decided operations: same-org rows
// evaluate serially so each check sees the earlier collections, keeping the
// in-flight set per scope at one as in the serial job (ADR 0004).
const COLLECTION_ROW_CONCURRENCY = 8;

type CollectionRowOutcome = "ok" | "failed" | "skipped" | "refused";

export interface CollectDueRecurringPaymentsResult {
  recovered: number;
  collected: number;
  failed: number;
  skipped: number;
  /** Rows money admission refused (HOO-1955): a period skipped or an operation reverted. */
  refused: number;
}

function emptyResult(): CollectDueRecurringPaymentsResult {
  return { recovered: 0, collected: 0, failed: 0, skipped: 0, refused: 0 };
}

function admissionFor(
  row: PaymentRecurringPaymentRow,
  operation: MoneyStartContext["operation"]
): { scope: MoneyAdmissionScope; context: MoneyStartContext } {
  return {
    scope: { organizationId: row.organization_id, projectId: row.project_id },
    context: { surface: "job", operation, subjectId: row.id },
  };
}

/**
 * A refused collection skips its period instead of failing, so the job never
 * retries it and re-entitlement does not catch it up (HOO-1955).
 */
async function skipRefusedPeriod(
  env: Env,
  row: CollectibleRecurringPaymentRow | RecoverableCollectionRecurringPaymentRow,
  refusal: MoneyMovementRefusedError
): Promise<CollectionRowOutcome> {
  try {
    const skipped = await skipRefusedRecurringCollectionPeriod({
      env,
      organizationId: row.organization_id,
      projectId: row.project_id,
      recurringPayment: row,
      refusal,
      now: new Date(),
    });
    // Not skipped: the cycle moved on or a collection already holds it, and
    // recovery finishes that one without signing.
    return skipped ? "refused" : "skipped";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    logCronFailure("collectDueRecurringPayments: failed to skip a refused period", row, error);
    return "failed";
  }
}

async function resolveSourceWallet(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<CustodyWallet | null> {
  if (!row.source_custody_wallet_id) {
    getLogger().warn(
      {
        organization_id: row.organization_id,
        project_id: row.project_id,
        recurring_payment_id: row.id,
        reason: "unresolved_source_wallet",
      },
      "collectDueRecurringPayments: recurring payment has no exact source wallet"
    );
    return null;
  }

  const wallet = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletById({
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.source_custody_wallet_id,
  });
  if (
    !wallet ||
    wallet.walletId !== row.source_wallet_id ||
    wallet.publicKey !== row.source_address
  ) {
    getLogger().warn(
      {
        organization_id: row.organization_id,
        project_id: row.project_id,
        recurring_payment_id: row.id,
        custody_wallet_id: row.source_custody_wallet_id,
        reason: "source_wallet_mismatch",
      },
      "collectDueRecurringPayments: recurring payment source wallet does not match its pin"
    );
    return null;
  }
  return wallet;
}

function shouldSkipCollectionError(error: Error): boolean {
  return error instanceof AppError && error.code === "CONFLICT";
}

function logCronFailure(message: string, row: PaymentRecurringPaymentRow, error: Error): void {
  getLogger().error(
    {
      error: error.message,
      organization_id: row.organization_id,
      project_id: row.project_id,
      recurring_payment_id: row.id,
    },
    message
  );
}

async function collectRow(
  env: Env,
  row: CollectibleRecurringPaymentRow | RecoverableCollectionRecurringPaymentRow
): Promise<CollectionRowOutcome> {
  const { scope, context } = admissionFor(row, "recurring_payment.collect");
  try {
    const sourceWallet = await resolveSourceWallet(env, row);
    if (!sourceWallet) {
      // A refused organization skips the period rather than journaling a
      // failure every retry window.
      const decision = await checkMoneyStart(env, scope, context);
      if (!decision.admitted) {
        return skipRefusedPeriod(env, row, new MoneyMovementRefusedError(decision.reason));
      }
      await journalAutomatedCollectionFailure({
        env,
        organizationId: row.organization_id,
        projectId: row.project_id,
        recurringPayment: row,
        initiatedByKeyId: null,
        error: conflict(
          row.source_custody_wallet_id
            ? "Recurring payment source wallet does not match its pin"
            : "Recurring payment source wallet is unresolved"
        ),
      });
      return "failed";
    }
    await collectRecurringPayment({
      env,
      organizationId: row.organization_id,
      projectId: row.project_id,
      sourceWallet,
      recurringPayment: row,
      initiatedByKeyId: null,
      collectionSource: "automated",
      admitStart: () => assertMoneyStartAdmitted(env, scope, context),
    });
    return "ok";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof MoneyMovementRefusedError) {
      return skipRefusedPeriod(env, row, error);
    }
    if (shouldSkipCollectionError(error)) {
      return "skipped";
    }
    logCronFailure("collectDueRecurringPayments: failed to collect recurring payment", row, error);
    return "failed";
  }
}

async function recoverLifecycleRow(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<CollectionRowOutcome> {
  try {
    const sourceWallet = await resolveSourceWallet(env, row);
    if (!sourceWallet) {
      return "failed";
    }
    const input = {
      env,
      organizationId: row.organization_id,
      projectId: row.project_id,
      sourceWallet,
      recurringPayment: row,
    };
    if (isActivatingRecurringPaymentStatus(row.status)) {
      const { scope, context } = admissionFor(row, "recurring_payment.activate");
      await activateRecurringPayment({
        ...input,
        createdBy: row.created_by,
        admitStart: () => assertMoneyStartAdmitted(env, scope, context),
      });
      return "ok";
    }
    const operation = recurringPaymentInFlightLifecycleOperation(row.status);
    if (operation === "cancel") {
      // An exit: never refused, for deleted and unentitled organizations alike.
      await cancelRecurringPayment(input);
      return "ok";
    }
    if (operation === "resume") {
      const { scope, context } = admissionFor(row, "recurring_payment.resume");
      await resumeRecurringPayment({
        ...input,
        admitStart: () => assertMoneyStartAdmitted(env, scope, context),
      });
      return "ok";
    }
    throw internalError(`Unhandled lifecycle status ${row.status}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The operation's own failure path already failed the attempt and reset
    // the row to a status the job does not select (activation:
    // `pending_activation`, resume: `canceled`).
    if (error instanceof MoneyMovementRefusedError) {
      return "refused";
    }
    if (shouldSkipCollectionError(error)) {
      return "skipped";
    }
    logCronFailure(
      "collectDueRecurringPayments: failed to recover recurring payment operation",
      row,
      error
    );
    return "failed";
  }
}

function addOutcome(
  result: CollectDueRecurringPaymentsResult,
  outcome: CollectionRowOutcome,
  okKey: "recovered" | "collected"
): void {
  switch (outcome) {
    case "ok":
      result[okKey] += 1;
      return;
    case "skipped":
      result.skipped += 1;
      return;
    case "refused":
      result.refused += 1;
      return;
    case "failed":
      result.failed += 1;
      return;
    default: {
      const unreachable: never = outcome;
      throw internalError(`Unhandled collection outcome ${String(unreachable)}`);
    }
  }
}

async function processRowsConcurrently<T extends PaymentRecurringPaymentRow>(
  result: CollectDueRecurringPaymentsResult,
  rows: T[],
  okKey: "recovered" | "collected",
  run: (row: T) => Promise<CollectionRowOutcome>
): Promise<void> {
  const orgBatches = new Map<string, T[]>();
  for (const row of rows) {
    const batch = orgBatches.get(row.organization_id);
    if (batch) {
      batch.push(row);
    } else {
      orgBatches.set(row.organization_id, [row]);
    }
  }

  const settled = await mapSettledWithConcurrency(
    [...orgBatches.values()],
    COLLECTION_ROW_CONCURRENCY,
    async (batch) => {
      const outcomes: CollectionRowOutcome[] = [];
      for (const row of batch) {
        outcomes.push(await run(row));
      }
      return outcomes;
    }
  );
  for (const batch of settled) {
    if (batch.status === "rejected") {
      throw batch.reason;
    }
    for (const outcome of batch.value) {
      addOutcome(result, outcome, okKey);
    }
  }
}

export async function collectDueRecurringPayments(
  env: Env,
  now: Date
): Promise<CollectDueRecurringPaymentsResult> {
  const result = emptyResult();
  const limit = RECURRING_PAYMENT_COLLECTION_CONFIG.batchSize;
  const dueBefore = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - RECURRING_PAYMENT_COLLECTION_CONFIG.staleAfterMs
  ).toISOString();
  const retryBefore = new Date(
    now.getTime() - RECURRING_PAYMENT_COLLECTION_CONFIG.retryAfterMinutes * 60 * 1000
  ).toISOString();
  const recurringPaymentsRepo = createPostgresPaymentRecurringPaymentsRepository(getDb(env));

  const staleLifecyclePayments = await recurringPaymentsRepo.listStaleLifecyclePayments({
    staleBefore,
    limit,
  });
  await processRowsConcurrently(result, staleLifecyclePayments, "recovered", (row) =>
    recoverLifecycleRow(env, row)
  );

  const staleUpdatePayments = await recurringPaymentsRepo.listStaleUpdatePayments({
    staleBefore,
    limit,
  });
  const newestStaleUpdate = staleUpdatePayments[0];
  if (newestStaleUpdate) {
    getLogger().warn(
      {
        oldest_updated_at: newestStaleUpdate.oldest_updated_at,
        reason: "stale_recurring_payment_updates",
        recurring_payments: staleUpdatePayments.map((row) => ({
          organization_id: row.organization_id,
          project_id: row.project_id,
          recurring_payment_id: row.id,
          updated_at: row.updated_at,
        })),
        stale_count: newestStaleUpdate.stale_count,
        truncated: newestStaleUpdate.stale_count > staleUpdatePayments.length,
      },
      "collectDueRecurringPayments: recurring payment updates are stale; collections stay paused until callers retry the same updates"
    );
  }

  const staleCollectionPayments = await recurringPaymentsRepo.listRecoverableCollectionPayments({
    staleBefore,
    limit,
  });
  await processRowsConcurrently(result, staleCollectionPayments, "recovered", (row) =>
    collectRow(env, row)
  );

  const duePayments = await recurringPaymentsRepo.listDueCollectionPayments({
    dueBefore,
    retryBefore,
    limit,
  });
  await processRowsConcurrently(result, duePayments, "collected", (row) => collectRow(env, row));

  return result;
}
