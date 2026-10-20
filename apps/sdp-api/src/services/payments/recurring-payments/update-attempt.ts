import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  type PaymentRecurringPaymentUpdateAttemptMode,
} from "@sdp/types/payments";
import type { TransactionSigner } from "@solana/kit";
import {
  generateRecurringPaymentUpdateAttemptId,
  generateRecurringPaymentUpdateEventId,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentUpdateAttemptRow,
  type RecurringPaymentStepSignatureSlot,
  type StoredRecurringPaymentActivator,
} from "@/db/repositories/payment-recurring-payments.repository";
import { type AppError, conflict, internalError } from "@/lib/errors";
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";
import {
  lazyRecurringPaymentStepSigner,
  type RecurringPaymentSourceWallet,
  type RecurringPaymentStepLogContext,
  requireUpdatedAttempt,
} from "./shared";
import {
  type RecurringPaymentUpdateIdempotency,
  updateAttemptMatchesRequest,
} from "./update-request";

export async function recordRecurringPaymentUpdateEvent(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string | null;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}): Promise<void> {
  const event = await input.recurringRepo.createUpdateEvent({
    id: generateRecurringPaymentUpdateEventId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attemptId,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });

  if (!event) {
    throw internalError("Failed to journal recurring payment update");
  }
}

/**
 * Records that a keyed PATCH was answered without an attempt of its own: a
 * request that changes nothing, or one that finished a stale attempt another
 * key claimed. The confirmed attempt carries this request's key and
 * fingerprint and changes nothing, so a retry once the key's shared record has
 * expired is answered from it instead of applying its terms again over a newer
 * edit. The fingerprint check is the key step's, as for any update attempt.
 * An unkeyed request, or one whose own attempt carries its key, records nothing.
 */
export async function recordAnsweredUpdate(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  /** The key on the attempt this request ran; null when it ran none. */
  ranAttemptKey: string | null;
}): Promise<void> {
  if (input.idempotency === null || input.idempotency.key === input.ranAttemptKey) {
    return;
  }
  const answeredAt = new Date().toISOString();
  const attempt = await input.recurringRepo.createUpdateAttempt({
    id: generateRecurringPaymentUpdateAttemptId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    mode: "metadata_schedule",
    status: "confirmed",
    stage: "finalize",
    oldPlanId: null,
    oldSubscriptionId: null,
    newPlanId: null,
    newSubscriptionId: null,
    newSourceCustodyWalletId: null,
    planUpdateSignature: null,
    planCreationSignature: null,
    authorizationSetupSignature: null,
    authorizationSignature: null,
    oldCancelSignature: null,
    changedFields: [],
    beforeValues: {},
    afterValues: {},
    error: null,
    createdBy: input.createdBy,
    createdAt: answeredAt,
    updatedAt: answeredAt,
    idempotencyKey: input.idempotency.key,
    idempotencyFingerprint: input.idempotency.fingerprint,
  });
  if (!attempt) {
    throw internalError("Failed to journal recurring payment update");
  }
}

/**
 * The in-flight attempt a stale `updating` schedule resumes. An `updating` schedule always has
 * one: its first claim opened it in the same transaction. None means another run finished the
 * update; read inside a claim's transaction, it means the claim took a schedule that run left
 * `active` (the claim also takes `active` rows). The resume is refused and a claim rolls back, so
 * a resumer never opens a fresh attempt that nobody admitted.
 *
 * @param recurringRepo - The claim transaction's repository.
 * @param input - The claimed schedule.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The claimed schedule.
 * @returns The in-flight attempt.
 * @throws AppError CONFLICT when the schedule has no in-flight update attempt.
 */
export async function requireResumedUpdateAttempt(
  recurringRepo: PaymentRecurringPaymentsRepository,
  input: { organizationId: string; projectId: string; recurringPaymentId: string }
): Promise<PaymentRecurringPaymentUpdateAttemptRow> {
  const attempt = await recurringRepo.getLatestUpdateAttempt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  });
  if (attempt === null) {
    throw conflict("Recurring payment update finished before it was resumed");
  }
  return attempt;
}

export async function getOrCreateRecurringPaymentUpdateAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  newSourceCustodyWalletId: string | null;
  createdBy: string | null;
  nowIso: string;
  recoveringStaleUpdate: boolean;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  previousActivator: StoredRecurringPaymentActivator | null;
}): Promise<PaymentRecurringPaymentUpdateAttemptRow> {
  // A stale claim resumes the in-flight attempt under its original key, or
  // records this request's key and fingerprint on it when it has none.
  if (input.recoveringStaleUpdate) {
    const existing = await requireResumedUpdateAttempt(input.recurringRepo, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
    });
    if (
      existing.mode !== input.mode ||
      existing.new_source_custody_wallet_id !== input.newSourceCustodyWalletId ||
      !updateAttemptMatchesRequest(existing, {
        changedFields: input.changedFields,
        beforeValues: input.beforeValues,
        afterValues: input.afterValues,
      })
    ) {
      throw conflict("Recurring payment update recovery must retry the same update");
    }
    return requireUpdatedAttempt(
      await input.recurringRepo.updateUpdateAttempt({
        attemptId: existing.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        error: null,
        adoptIdempotencyKey: input.idempotency?.key ?? null,
        adoptIdempotencyFingerprint: input.idempotency?.fingerprint ?? null,
        updatedAt: input.nowIso,
      })
    );
  }

  const attempt = await input.recurringRepo.createUpdateAttempt({
    id: generateRecurringPaymentUpdateAttemptId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    mode: input.mode,
    status: "processing",
    stage: "claim",
    oldPlanId: input.claimed.plan_id,
    oldSubscriptionId: input.claimed.subscription_id,
    newPlanId: null,
    newSubscriptionId: null,
    newSourceCustodyWalletId: input.newSourceCustodyWalletId,
    planUpdateSignature: null,
    planCreationSignature: null,
    authorizationSetupSignature: null,
    authorizationSignature: null,
    oldCancelSignature: null,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    error: null,
    createdBy: input.createdBy,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    idempotencyKey: input.idempotency?.key ?? null,
    idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    previousActivator: input.previousActivator,
  });

  if (!attempt) {
    throw internalError("Failed to journal recurring payment update");
  }

  return attempt;
}

/** An update attempt's step signature slot. */
export type UpdateAttemptStepSlot = Extract<
  RecurringPaymentStepSignatureSlot,
  { row: "update_attempt" }
>;
export type UpdateAttemptStepColumn = UpdateAttemptStepSlot["column"];

/**
 * Logs and returns the refusal of an update step the cron would send. The cron's mandate admits no
 * `recurring.update` (`MANDATE_MOVEMENT_STATUSES`), so the cron never starts an update send: the
 * unsent step fails the update back to `active` on its old terms, and a same-key PATCH can still
 * send it.
 *
 * @param logContext - The schedule and attempt the error log names.
 * @returns The CONFLICT error the step fails with.
 */
export function refuseCronUpdateStepSend(
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">
): AppError {
  logEvent("error", {
    event: "sdp_api_recurring_payment_step_unsendable",
    ...logContext,
    movement: "recurring.update",
    reason: "cron_starts_no_update_send",
  });
  return conflict("The cron sends no new recurring payment update step; retry the update");
}

/**
 * The signer an update's unwinding steps send with, resolved only when a step needs a new send,
 * after every saved step was read. A request resolves the wallet's signer then, and the signing
 * waist decides each signature (a fresh update was admitted before its claim). The cron gets one
 * that refuses (`refuseCronUpdateStepSend`), which fails the update back to `active`.
 *
 * @param input - The wallet the steps sign with and who runs them.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The wallet the steps sign with.
 * @param input.startsAllowed - False when the cron runs the update: no new update send.
 * @param input.logContext - The schedule and attempt the error logs name.
 * @returns A function that resolves the signer, or throws the refusal.
 */
export function updateStepSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  startsAllowed: boolean;
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">;
}): () => Promise<TransactionSigner> {
  if (input.startsAllowed) {
    return lazyRecurringPaymentStepSigner({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      movement: "recurring.update",
      admitRecovered: null,
      logContext: input.logContext,
    });
  }
  return async () => {
    throw refuseCronUpdateStepSend(input.logContext);
  };
}
