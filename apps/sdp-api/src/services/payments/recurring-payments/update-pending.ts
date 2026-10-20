import { RECURRING_PAYMENT_ACTIVATION_TRANSITION } from "@sdp/types/payments";
import { getDb } from "@/db/client";
import {
  generateRecurringPaymentUpdateAttemptId,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import { createPaymentRecurringPaymentsRepository } from "@/db/repositories/repository-factory";
import { conflict, internalError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";
import { recordAnsweredUpdate, recordRecurringPaymentUpdateEvent } from "./update-attempt";
import {
  REPLACEMENT_UPDATE_FIELDS,
  type RecurringPaymentUpdateIdempotency,
  type ResolvedRecurringPaymentUpdate,
} from "./update-request";

/**
 * Updates a schedule that never went on chain. The row, a confirmed update
 * attempt carrying the request's key and fingerprint, and the update event
 * commit together, so a retry of the same request is answered from the attempt
 * (HOO-1918), as a pending schedule's cancel is.
 */
export async function updatePendingRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.resolved.changedFields.length === 0) {
    await recordAnsweredUpdate({
      ...input,
      recurringRepo: createPaymentRecurringPaymentsRepository(input.env, createTenantScope(input)),
      ranAttemptKey: null,
    });
    return input.recurringPayment;
  }

  const changedDestinationOrToken =
    input.resolved.destinationAddress !== input.recurringPayment.destination_address ||
    input.resolved.token !== input.recurringPayment.token;
  const updatedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const updated = await updatePendingRecurringPaymentRow(recurringRepo, {
      ...input,
      changedDestinationOrToken,
      updatedAt,
    });
    const attempt = await recurringRepo.createUpdateAttempt({
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
      newSourceCustodyWalletId:
        input.resolved.sourceWallet.id === input.recurringPayment.source_custody_wallet_id
          ? null
          : input.resolved.sourceWallet.id,
      planUpdateSignature: null,
      planCreationSignature: null,
      authorizationSetupSignature: null,
      authorizationSignature: null,
      oldCancelSignature: null,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      error: null,
      createdBy: input.createdBy,
      createdAt: updatedAt,
      updatedAt,
      idempotencyKey: input.idempotency?.key ?? null,
      idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    });
    if (!attempt) {
      throw internalError("Failed to journal recurring payment update");
    }
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attemptId: attempt.id,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      createdBy: input.createdBy,
      createdAt: updatedAt,
    });
    return updated;
  });
}

/**
 * Writes a pending schedule's new values in one CAS write on its status and `updated_at`. A change
 * to anything the plan carries (every field but `firstCollectionAt`) drops the plan and
 * subscription references, so activation creates a fresh plan with a new program plan id and a
 * fresh subscription instead of reusing rows with the old terms or subscriber; the orphan rows stay.
 *
 * @param recurringRepo - The transaction's recurring payments repository.
 * @param input - The schedule, its resolved update and the write's timestamp.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPayment - The pending schedule as read.
 * @param input.resolved - The resolved update.
 * @param input.changedDestinationOrToken - Whether the destination or token changed, which drops the destination token account.
 * @param input.updatedAt - The write's timestamp.
 * @returns The updated schedule.
 * @throws AppError CONFLICT when the schedule changed since it was read.
 */
async function updatePendingRecurringPaymentRow(
  recurringRepo: PaymentRecurringPaymentsRepository,
  input: {
    organizationId: string;
    projectId: string;
    recurringPayment: PaymentRecurringPaymentRow;
    resolved: ResolvedRecurringPaymentUpdate;
    changedDestinationOrToken: boolean;
    updatedAt: string;
  }
): Promise<PaymentRecurringPaymentRow> {
  const { changedDestinationOrToken, updatedAt } = input;
  const dropsPlanReference = input.resolved.changedFields.some(
    (field) => REPLACEMENT_UPDATE_FIELDS.has(field) || field === "metadataUri"
  );
  const updated = await recurringRepo.updateRecurringPayment({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceCustodyWalletId: input.resolved.sourceWallet.id,
    sourceWalletId: input.resolved.sourceWallet.walletId,
    sourceAddress: input.resolved.sourceWallet.publicKey,
    counterpartyId: input.resolved.counterpartyId,
    counterpartyAccountId: input.resolved.counterpartyAccountId,
    destinationAddress: input.resolved.destinationAddress,
    destinationTokenAccount: changedDestinationOrToken
      ? null
      : input.recurringPayment.destination_token_account,
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    firstCollectionAt: input.resolved.firstCollectionAt,
    metadataUri: input.resolved.metadataUri,
    planId: dropsPlanReference ? null : input.recurringPayment.plan_id,
    planPda: dropsPlanReference ? null : input.recurringPayment.plan_pda,
    planCreatedAt: dropsPlanReference ? null : input.recurringPayment.plan_created_at,
    planCreationSignature: dropsPlanReference
      ? null
      : input.recurringPayment.plan_creation_signature,
    subscriptionId: dropsPlanReference ? null : input.recurringPayment.subscription_id,
    subscriptionPda: dropsPlanReference ? null : input.recurringPayment.subscription_pda,
    subscriptionAuthorityAddress: dropsPlanReference
      ? null
      : input.recurringPayment.subscription_authority_address,
    authorizationSignature: dropsPlanReference
      ? null
      : input.recurringPayment.authorization_signature,
    expectedStatus: RECURRING_PAYMENT_ACTIVATION_TRANSITION.claimableStatus,
    expectedUpdatedAt: input.recurringPayment.updated_at,
    updatedAt,
  });

  if (!updated) {
    throw conflict("Recurring payment changed while updating; retry with the latest payment");
  }
  return updated;
}
