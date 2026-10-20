import { currentClusterScope } from "@sdp/rpc/scope";
import { RECURRING_PAYMENT_COLLECTION_CONFIG } from "@sdp/types/payments";
import { getDb } from "@/db/client";
import type {
  CollectibleRecurringPaymentRow,
  PaymentRecurringPaymentRow,
  RecoverableCollectionRecurringPaymentRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { AppError, conflict, internalError } from "@/lib/errors";
import {
  assertMoneyStartAdmitted,
  checkMoneyStart,
  type MoneyAdmissionScope,
  type MoneyAdmissionSubject,
  MoneyMovementRefusedError,
  type MoneyStartContext,
} from "@/lib/money-admission";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { getLogger } from "@/runtime/logger";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { activateRecurringPayment } from "@/services/payments/recurring-payments/activation";
import {
  collectRecurringPayment,
  journalAutomatedCollectionFailure,
  skipRefusedRecurringCollectionPeriod,
} from "@/services/payments/recurring-payments/collection";
import {
  cancelRecurringPayment,
  resumeRecurringPayment,
} from "@/services/payments/recurring-payments/lifecycle";
import type { RecurringPaymentSourceWallet } from "@/services/payments/recurring-payments/shared";
import { resumeRecurringPaymentUpdate } from "@/services/payments/recurring-payments/update";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

// Rows are independent: collection, activation, and lifecycle recovery each
// claim their recurring payment under a row lock before touching the chain.
// Batches fan out per organization because policy velocity sums (spending
// limits) are org-scoped and only count decided operations: same-org rows
// evaluate serially so each check sees the earlier collections, keeping the
// in-flight set per scope at one as in the serial job (ADR 0004). That holds
// within one environment's run only: the Sandbox and Production runs are
// concurrent, so velocity scoped to an organization across environments
// needs to become environment-bound before it relies on this (PRO-1933).
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
  movement: MoneyStartContext["movement"]
): {
  scope: MoneyAdmissionScope;
  context: MoneyStartContext;
  subject: MoneyAdmissionSubject;
} {
  return {
    scope: { organizationId: row.organization_id, projectId: row.project_id },
    context: { surface: "job", movement, subjectId: row.id },
    subject: { custodyWalletId: row.source_custody_wallet_id },
  };
}

/**
 * Each row runs as its own mandate (APE-343): the waists admit it by the
 * recurring payment's live row (status, source wallet), never by the key or
 * member who created or activated it, so revoking that key does not stop the
 * schedule. "Revoke and cancel its recurring payments" is the explicit path.
 */
function asMandate<T>(row: PaymentRecurringPaymentRow, work: () => Promise<T>): Promise<T> {
  return runAsMoneyPrincipal({ kind: "mandate", recurringPaymentId: row.id }, work);
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

/**
 * The schedule's source wallet as its row pins it, for a flow that resolves the signer itself
 * only when it needs a new send, so a wallet that can no longer sign still finishes what landed.
 * A schedule with no exact source wallet is logged and has none.
 *
 * @param row - The schedule.
 * @returns The pinned wallet, or null when the schedule pins no exact custody wallet.
 */
function pinnedSourceWallet(row: PaymentRecurringPaymentRow): RecurringPaymentSourceWallet | null {
  if (row.source_custody_wallet_id === null) {
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
  return {
    id: row.source_custody_wallet_id,
    walletId: row.source_wallet_id,
    publicKey: row.source_address,
  };
}

async function resolveSourceWallet(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<CustodyWallet | null> {
  const pin = pinnedSourceWallet(row);
  if (pin === null) {
    return null;
  }

  const wallet = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletById({
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: pin.id,
  });
  if (!wallet || wallet.walletId !== pin.walletId || wallet.publicKey !== pin.publicKey) {
    getLogger().warn(
      {
        organization_id: row.organization_id,
        project_id: row.project_id,
        recurring_payment_id: row.id,
        custody_wallet_id: pin.id,
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
      environment: currentClusterScope().environment,
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
  const { scope, context, subject } = admissionFor(row, "recurring.collect");
  try {
    const sourceWallet = await resolveSourceWallet(env, row);
    if (!sourceWallet) {
      // A refused organization skips the period rather than journaling a
      // failure every retry window.
      const decision = await checkMoneyStart(env, scope, context, subject);
      if (!decision.admitted) {
        return skipRefusedPeriod(env, row, MoneyMovementRefusedError.of(decision));
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
      admitStart: () => assertMoneyStartAdmitted(env, scope, context, subject),
      idempotencyKey: null,
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

/**
 * Recovers one stale in-flight schedule through its flow, which reads each saved step from the
 * chain before it sends anything: landed steps finish, a pending one waits for the next tick, and
 * a step that needs a new send the wallet or the mandate cannot make fails the flow back to its
 * last stable status with an error log (`activating` to `pending_activation`, `updating` to
 * `active`, `canceling` to `active`, `resuming` to `canceled`).
 *
 * @param env - The environment.
 * @param row - The stale schedule.
 * @returns `ok` when the flow finished, `skipped` when it is pending, held by another run or
 *   failed back (CONFLICT), `refused` when money admission refused it, and `failed` otherwise.
 */
async function recoverLifecycleRow(
  env: Env,
  row: PaymentRecurringPaymentRow
): Promise<CollectionRowOutcome> {
  try {
    const sourceWallet = pinnedSourceWallet(row);
    if (sourceWallet === null) {
      return "failed";
    }
    const input = {
      env,
      organizationId: row.organization_id,
      projectId: row.project_id,
      sourceWallet,
      recurringPayment: row,
      // The cron resumes a row under the key of the request that claimed it.
      idempotencyKey: null,
    };
    switch (row.status) {
      case "activating": {
        const { scope, context, subject } = admissionFor(row, "recurring.activate");
        await activateRecurringPayment({
          ...input,
          createdBy: row.created_by,
          admitStart: () => assertMoneyStartAdmitted(env, scope, context, subject),
        });
        return "ok";
      }
      case "updating":
        await resumeRecurringPaymentUpdate({
          env,
          organizationId: row.organization_id,
          projectId: row.project_id,
          sourceWallet,
          recurringPayment: row,
        });
        return "ok";
      case "canceling":
        // An exit: never refused, for deleted and unentitled organizations alike.
        await cancelRecurringPayment({ ...input, admitCaller: null });
        return "ok";
      case "resuming": {
        const { scope, context, subject } = admissionFor(row, "recurring.resume");
        await resumeRecurringPayment({
          ...input,
          admitStart: () => assertMoneyStartAdmitted(env, scope, context, subject),
        });
        return "ok";
      }
      case "pending_activation":
      case "active":
      case "paused":
      case "expired":
      case "canceled":
        throw internalError(`Unhandled lifecycle status ${row.status}`);
      default: {
        const unreachable: never = row.status;
        throw internalError(`Unhandled lifecycle status ${String(unreachable)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // The operation's own failure path already failed the attempt and reset
    // the row to a status the job does not select (activation:
    // `pending_activation`, update and cancel: `active`, resume: `canceled`).
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

/**
 * Recover stale in-flight operations (activation, update, cancel, resume) and collections, then
 * collect due recurring payments, for the open cluster scope's environment only. The Worker
 * registers it once per environment (a `cluster` Cron Definition), so every row is built, sent and
 * confirmed on its project's cluster.
 *
 * @param env - Runtime environment for repository and signer construction.
 * @param now - Tick time anchoring the due, stale and retry windows.
 * @returns Per-outcome row counts for this environment's run.
 */
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
  const { environment } = currentClusterScope();

  const staleLifecyclePayments = await recurringPaymentsRepo.listStaleLifecyclePayments({
    environment,
    staleBefore,
    limit,
  });
  await processRowsConcurrently(result, staleLifecyclePayments, "recovered", (row) =>
    asMandate(row, () => recoverLifecycleRow(env, row))
  );

  const staleCollectionPayments = await recurringPaymentsRepo.listRecoverableCollectionPayments({
    environment,
    staleBefore,
    limit,
  });
  await processRowsConcurrently(result, staleCollectionPayments, "recovered", (row) =>
    asMandate(row, () => collectRow(env, row))
  );

  const duePayments = await recurringPaymentsRepo.listDueCollectionPayments({
    environment,
    dueBefore,
    retryBefore,
    limit,
  });
  await processRowsConcurrently(result, duePayments, "collected", (row) =>
    asMandate(row, () => collectRow(env, row))
  );

  return result;
}
