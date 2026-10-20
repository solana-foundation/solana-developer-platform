import { getRecurringPaymentOperationStaleBefore } from "@sdp/payments/recurring-payment-lifecycle";
import {
  assertNever,
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  isPendingActivationRecurringPaymentStatus,
  isUpdatingRecurringPaymentStatus,
  type PaymentRecurringPaymentUpdateAttemptMode,
  RECURRING_PAYMENT_UPDATE_TRANSITION,
  type UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types/payments";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentUpdateAttemptRow,
  RecurringPaymentActivator,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type { PaymentSubscriptionRow } from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { badRequest, conflict, internalError } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  fenceRecurringPaymentStepFailure,
  journalInFlightRecurringPaymentAttempt,
  lockLiveActivatingKey,
  type RecurringPaymentSourceWallet,
  RecurringPaymentStepFailedError,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
} from "./shared";
import {
  getOrCreateRecurringPaymentUpdateAttempt,
  recordAnsweredUpdate,
  refuseCronUpdateStepSend,
  requireResumedUpdateAttempt,
} from "./update-attempt";
import { runMetadataScheduleUpdate } from "./update-metadata";
import { updatePendingRecurringPayment } from "./update-pending";
import { runReplacementUpdate } from "./update-replacement";
import {
  assertRecurringPaymentUpdateStatus,
  type ClaimedUpdateStarts,
  RECURRING_PAYMENT_UPDATE_FIELDS,
  type RecurringPaymentUpdateIdempotency,
  type RecurringPaymentUpdateTerms,
  recurringPaymentUpdateSnapshotSchema,
  requestedActiveUpdateMode,
  resolveRecurringPaymentUpdate,
} from "./update-request";

/**
 * Fails an update whose unwinding step cannot land, in one transaction: fences the step's slot (a
 * dropped signature is cleared while the slot still holds it; otherwise the slot must still be
 * empty), fails the attempt (its stage stays where the
 * run left it), and moves the schedule from `updating` back to `active` with the activator it had.
 * Both writes are fenced to this run: the attempt must still be `processing`, and the schedule
 * must still carry this run's claim stamp, so a stalled run never undoes a later run's re-claim.
 *
 * @param input - The run's schedule, attempt and step failure.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.claimed - The claimed schedule.
 * @param input.attempt - The run's attempt.
 * @param input.stepFailure - The step failure.
 * @throws AppError CONFLICT when the slot fence fails, the attempt is no longer `processing`, or
 *   the schedule left this run's claim; the transaction rolls back and the
 *   attempt stays in flight.
 */
async function failRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  stepFailure: RecurringPaymentStepFailedError;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    await fenceRecurringPaymentStepFailure({
      recurringRepo,
      attemptId: input.attempt.id,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stepFailure: input.stepFailure,
      updatedAt: failedAt,
    });
    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        error: recurringPaymentErrorMessage(input.stepFailure.failure),
        expectedStatus: "processing",
        updatedAt: failedAt,
      })
    );
    const updatedRecurringPayment = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: RECURRING_PAYMENT_UPDATE_TRANSITION.claimableStatus,
      expectedStatus: RECURRING_PAYMENT_UPDATE_TRANSITION.processingStatus,
      expectedUpdatedAt: input.claimed.updated_at,
      updatedAt: failedAt,
    });
    if (updatedRecurringPayment === null) {
      throw conflict("Recurring payment update changed concurrently");
    }
    // The new terms never took effect, so neither does the hand-over.
    if (input.attempt.previous_activator !== null) {
      await recurringRepo.restoreRecurringPaymentActivator({
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        activator: input.attempt.previous_activator,
      });
    }
  });
}

async function claimSourceChangingRecurringPaymentUpdate(input: {
  db: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: RecurringPaymentSourceWallet;
  updatedAt: string;
  staleBefore: string;
  activatedBy: RecurringPaymentActivator | null;
}): Promise<PaymentRecurringPaymentRow | null> {
  const locked = await input.db
    .prepare(
      `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = ?
            AND updated_at = ?
            AND source_custody_wallet_id = ?
            AND source_wallet_id = ?
            AND source_address = ?
            AND subscription_id IS NOT DISTINCT FROM ?
            AND next_collection_due_at IS NOT DISTINCT FROM ?
          FOR UPDATE`
    )
    .bind(
      input.recurringPayment.id,
      input.organizationId,
      input.projectId,
      input.recurringPayment.status,
      input.recurringPayment.updated_at,
      input.sourceWallet.id,
      input.sourceWallet.walletId,
      input.sourceWallet.publicKey,
      input.recurringPayment.subscription_id,
      input.recurringPayment.next_collection_due_at
    )
    .first<{ id: string }>();
  if (!locked) return null;

  if (input.recurringPayment.subscription_id && input.recurringPayment.next_collection_due_at) {
    const activeAttempt = await createPostgresPaymentSubscriptionsRepository(
      input.db
    ).getCollectionAttemptByDue({
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: input.recurringPayment.subscription_id,
      dueAt: input.recurringPayment.next_collection_due_at,
      statuses: COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
    });
    if (activeAttempt) return null;
  }

  return createPostgresPaymentRecurringPaymentsRepository(input.db).claimRecurringPaymentUpdate({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
    staleBefore: input.staleBefore,
    activatedBy: input.activatedBy,
  });
}

/**
 * Admits a fresh update that will sign, before its claim, for every wallet it
 * signs with: the source and, when the source changes, the new one, since the
 * caller must be able to sign with the wallet it moves the mandate away from as
 * well. A recovered update is never admitted here: its saved steps are read
 * first, the lazy step signer resolves the wallet only when a step needs a new
 * send, and the signing waist decides each signature (HOO-2099), so a wallet
 * that can no longer sign still finishes what landed.
 */
async function admitUpdateExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  walletIds: readonly string[];
  admitStart: (custodyWalletId: string) => Promise<void>;
}): Promise<void> {
  for (const walletId of input.walletIds) {
    await input.admitStart(walletId);
  }
  const signingService = createSigningService(input.env);
  for (const walletId of input.walletIds) {
    await signingService.admitRuntimeExecution(input.organizationId, input.projectId, walletId);
  }
}

/**
 * Claims an active recurring payment for an update and opens (or resumes) its
 * attempt, in one transaction.
 *
 * An update that changes where or how much money moves re-authorizes the
 * mandate, so its caller becomes the one it answers to: revoking that key
 * cancels the mandate, as revoking its activator does (HOO-2099). The claim
 * re-reads that key under a share lock, ordered against revocation as
 * activation's is. A metadata or schedule change leaves the activator alone,
 * and so does a recovered stale update, whose own claim recorded its caller.
 */
async function claimActiveRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: RecurringPaymentSourceWallet;
  newSourceCustodyWalletId: string | null;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  resolved: Pick<
    Awaited<ReturnType<typeof resolveRecurringPaymentUpdate>>,
    "changedFields" | "beforeValues" | "afterValues"
  >;
  createdBy: string | null;
  nowIso: string;
  recoveringStaleUpdate: boolean;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<{
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
} | null> {
  const updatedAt = new Date().toISOString();
  const staleBefore = getRecurringPaymentOperationStaleBefore(input.nowIso);
  const activatedBy =
    input.mode === "replacement" && !input.recoveringStaleUpdate ? currentMandateActivator() : null;
  return getDb(input.env).transaction(async (tx) => {
    await lockLiveActivatingKey(tx, {
      activator: activatedBy,
      organizationId: input.organizationId,
      projectId: input.projectId,
      movement: "recurring.update",
      recurringPaymentId: input.recurringPayment.id,
      // Moving the mandate signs with the wallet it leaves and the one it joins.
      custodyWalletIds: input.newSourceCustodyWalletId
        ? [input.sourceWallet.id, input.newSourceCustodyWalletId]
        : [input.sourceWallet.id],
    });
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    // Kept on the attempt, so an attempt abandoned before its terms take
    // effect hands the payment back to the activator it had.
    const previousActivator = activatedBy
      ? await transactionRepo.lockRecurringPaymentActivator({
          recurringPaymentId: input.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;
    const claimed = input.newSourceCustodyWalletId
      ? await claimSourceChangingRecurringPaymentUpdate({
          db: tx,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: input.recurringPayment,
          sourceWallet: input.sourceWallet,
          updatedAt,
          staleBefore,
          activatedBy,
        })
      : await transactionRepo.claimRecurringPaymentUpdate({
          recurringPaymentId: input.recurringPayment.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt,
          staleBefore,
          activatedBy,
        });
    if (!claimed) return null;
    const attempt = await getOrCreateRecurringPaymentUpdateAttempt({
      recurringRepo: transactionRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      mode: input.mode,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: input.resolved.afterValues,
      newSourceCustodyWalletId: input.newSourceCustodyWalletId,
      createdBy: input.createdBy,
      nowIso: input.nowIso,
      recoveringStaleUpdate: input.recoveringStaleUpdate,
      idempotency: input.idempotency,
      previousActivator,
    });
    return { claimed, attempt };
  });
}

export async function updateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  nextSourceWallet?: RecurringPaymentSourceWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
  /** The request's Idempotency-Key and body fingerprint, written on the attempt it claims. */
  idempotency: RecurringPaymentUpdateIdempotency | null;
  /**
   * Money admission (HOO-1955, HOO-2099) for one custody wallet a fresh
   * update will sign with, run before the attempt is claimed and only when it
   * signs: a refusal leaves the recurring payment untouched. A recovered
   * stale update skips it; the signing waist decides any signature it needs.
   */
  admitStart: (custodyWalletId: string) => Promise<void>;
}): Promise<PaymentRecurringPaymentRow> {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);

  const nowIso = new Date().toISOString();
  assertRecurringPaymentUpdateStatus(input.recurringPayment, nowIso);

  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    if (input.request.nextCollectionDueAt !== undefined) {
      throw badRequest("nextCollectionDueAt can only be updated after activation");
    }
    const resolved = await resolveRecurringPaymentUpdate(input);
    return updatePendingRecurringPayment({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      resolved,
      createdBy: input.createdBy,
      idempotency: input.idempotency,
    });
  }

  if (input.request.firstCollectionAt !== undefined) {
    throw badRequest("firstCollectionAt can only be updated before activation");
  }

  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const paymentsRepo = createPaymentsRepository(input.env, createTenantScope(input));
  const settled = await recoverOrBlockLifecycleCollection({
    env: input.env,
    recurringRepo,
    subscriptionsRepo,
    paymentsRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
  });
  assertRecurringPaymentUpdateStatus(settled.recurringPayment, new Date().toISOString());
  assertRecurringPaymentSourceWallet(settled.recurringPayment, input.sourceWallet);

  const resolved = await resolveRecurringPaymentUpdate({
    ...input,
    recurringPayment: settled.recurringPayment,
  });
  const sourceChanged = resolved.changedFields.includes("sourceCustodyWalletId");
  const mode = requestedActiveUpdateMode(resolved.changedFields);
  const requiresRuntimeExecution =
    mode === "replacement" || resolved.metadataUri !== settled.recurringPayment.metadata_uri;
  const recoveringStaleUpdate = isUpdatingRecurringPaymentStatus(settled.recurringPayment.status);
  if (requiresRuntimeExecution && !recoveringStaleUpdate) {
    await admitUpdateExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletIds: sourceChanged
        ? [input.sourceWallet.id, resolved.sourceWallet.id]
        : [input.sourceWallet.id],
      admitStart: input.admitStart,
    });
  }

  if (resolved.changedFields.length === 0) {
    await recordAnsweredUpdate({
      ...input,
      recurringRepo,
      recurringPayment: settled.recurringPayment,
      ranAttemptKey: null,
    });
    return settled.recurringPayment;
  }

  const claimResult = await claimActiveRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: settled.recurringPayment,
    sourceWallet: input.sourceWallet,
    newSourceCustodyWalletId: sourceChanged ? resolved.sourceWallet.id : null,
    mode,
    resolved,
    createdBy: input.createdBy,
    nowIso,
    recoveringStaleUpdate,
    idempotency: input.idempotency,
  });
  if (!claimResult) {
    throw conflict("Recurring payment update is already processing");
  }

  return runClaimedRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    claimed: claimResult.claimed,
    attempt: claimResult.attempt,
    subscription: settled.subscription,
    mode,
    resolved,
    requestedNextCollectionDueAt: input.request.nextCollectionDueAt,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
    starts: { allowed: true, destinationAddress: resolved.destinationAddress },
  });
}

/**
 * Runs a claimed update's steps from its attempt and settles the run. An unwinding step that
 * cannot land fails the update back to `active` on its old terms in one transaction; any other
 * error leaves the attempt in flight and records only the error, so a concurrent finalize is
 * never flipped back.
 *
 * @param input - The claimed schedule, its attempt and the update's resolved terms.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet before the update.
 * @param input.claimed - The claimed schedule.
 * @param input.attempt - The claim's in-flight attempt.
 * @param input.subscription - The schedule's subscription as collection recovery read it, or null.
 * @param input.mode - The attempt's mode.
 * @param input.resolved - The update's resolved terms.
 * @param input.requestedNextCollectionDueAt - The next due date the update asks for, null for the
 *   next period, or undefined when it asks for none.
 * @param input.createdBy - Who the update's journal names.
 * @param input.idempotency - The request's key and fingerprint; null for the cron.
 * @param input.starts - Whether the run may send new steps: a request may, toward the destination it
 *   resolved; the cron sends none.
 * @returns The schedule after the update.
 * @throws RecurringPaymentStepFailedError, answering as its failure, once the update failed back
 *   to `active`.
 */
async function runClaimedRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  subscription: PaymentSubscriptionRow | null;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  resolved: RecurringPaymentUpdateTerms;
  requestedNextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  starts: ClaimedUpdateStarts;
}): Promise<PaymentRecurringPaymentRow> {
  const { attempt, claimed } = input;
  try {
    switch (input.mode) {
      case "metadata_schedule":
        return await runMetadataScheduleUpdate({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          sourceWallet: input.sourceWallet,
          claimed,
          subscription: input.subscription,
          attempt,
          resolved: input.resolved,
          requestedNextCollectionDueAt: input.requestedNextCollectionDueAt,
          createdBy: input.createdBy,
          idempotency: input.idempotency,
          starts: input.starts,
        });
      case "replacement":
        return await runReplacementUpdate({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          oldSourceWallet: input.sourceWallet,
          claimed,
          subscription: input.subscription,
          attempt,
          resolved: input.resolved,
          requestedNextCollectionDueAt: input.requestedNextCollectionDueAt,
          createdBy: input.createdBy,
          idempotency: input.idempotency,
          starts: input.starts,
        });
      default:
        return assertNever(input.mode);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const stepFailure = error instanceof RecurringPaymentStepFailedError ? error : null;
    getLogger().error(
      {
        err: stepFailure === null ? error : stepFailure.failure,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment update failed"
    );
    if (stepFailure !== null) {
      await failRecurringPaymentUpdate({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        claimed,
        attempt,
        stepFailure,
      });
      throw stepFailure;
    }
    await journalInFlightRecurringPaymentAttempt({
      write: () =>
        createPaymentRecurringPaymentsRepository(
          input.env,
          createTenantScope(input)
        ).updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          error: recurringPaymentErrorMessage(error),
          expectedStatus: "processing",
          updatedAt: new Date().toISOString(),
        }),
      logContext: { recurring_payment_id: claimed.id, attempt_id: attempt.id },
    });

    throw error;
  }
}

const savedUpdateChangedFieldsSchema = z.array(z.enum(RECURRING_PAYMENT_UPDATE_FIELDS));

/**
 * A resumed update's terms, rebuilt from its attempt: the saved new terms, and for a replacement
 * that moves its source, the new wallet its plan row recorded (the row is written before the
 * plan's send). No destination is resolved again or taken from the row: the cron sends no plan
 * creation, and a landed plan's destination is read from the chain (`replacementFinalDestination`),
 * so neither an account archived since nor an edited plan row can strand or redirect the update.
 * With no plan row recorded, the replacement never reached a send.
 *
 * @param input - The schedule's pin and the attempt.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet pin.
 * @param input.attempt - The in-flight attempt.
 * @returns The terms and the next due date the update asks for, or null when a replacement never
 *   reached its plan.
 * @throws ZodError when the attempt's saved values are not a snapshot.
 * @throws AppError INTERNAL_ERROR when the attempt's new source is inconsistent or its plan row is
 *   missing.
 */
async function resumedUpdateTerms(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
}): Promise<{
  resolved: RecurringPaymentUpdateTerms;
  requestedNextCollectionDueAt: string | null | undefined;
} | null> {
  const before = recurringPaymentUpdateSnapshotSchema.parse(input.attempt.before_values);
  const after = recurringPaymentUpdateSnapshotSchema.parse(input.attempt.after_values);
  const changedFields = savedUpdateChangedFieldsSchema.parse(input.attempt.changed_fields);
  const terms = (sourceWallet: RecurringPaymentSourceWallet) => ({
    resolved: {
      sourceWallet,
      counterpartyId: after.counterpartyId,
      counterpartyAccountId: after.counterpartyAccountId,
      token: after.token,
      amount: after.amount,
      periodHours: after.periodHours,
      firstCollectionAt: after.firstCollectionAt,
      nextCollectionDueAt: after.nextCollectionDueAt,
      metadataUri: after.metadataUri,
      changedFields,
      beforeValues: before,
      afterValues: after,
    },
    requestedNextCollectionDueAt: changedFields.includes("nextCollectionDueAt")
      ? after.nextCollectionDueAt
      : undefined,
  });
  switch (input.attempt.mode) {
    case "metadata_schedule":
      return terms(input.sourceWallet);
    case "replacement": {
      if (input.attempt.new_plan_id === null) {
        return null;
      }
      const nextSourceCustodyWalletId = after.sourceCustodyWalletId;
      if (nextSourceCustodyWalletId === input.sourceWallet.id) {
        return terms(input.sourceWallet);
      }
      if (
        nextSourceCustodyWalletId === null ||
        input.attempt.new_source_custody_wallet_id !== nextSourceCustodyWalletId
      ) {
        throw internalError("Recurring payment update attempt names an inconsistent source wallet");
      }
      const plan = await createPaymentSubscriptionsRepository(
        input.env,
        createTenantScope(input)
      ).getPlanById({
        planId: input.attempt.new_plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
      if (plan === null) {
        throw internalError("Recurring payment replacement plan was not found");
      }
      // The new wallet's ids come from the row; its address is checked against the plan's owner
      // on chain wherever the plan is read landed (`replacementFinalDestination`).
      return terms({
        id: nextSourceCustodyWalletId,
        walletId: plan.owner_wallet_id,
        publicKey: plan.owner_address,
      });
    }
    default:
      return assertNever(input.attempt.mode);
  }
}

/**
 * Resumes a stale `updating` schedule for the cron, from the attempt its first claim opened. The
 * terms are rebuilt from that attempt before the claim, so a schedule whose terms cannot be read
 * is never claimed. The claim takes the schedule while it is still stale (`updating`, unchanged
 * for the stale window), so the cron and a stale same-key PATCH race safely: the first claimant
 * runs and the other gets a 409. The claim re-reads the attempt (`requireResumedUpdateAttempt`)
 * and rolls back unless it is the same one, unchanged; a fresh attempt is never opened.
 *
 * The run uses the attempt's saved terms and creator, with no idempotency key, and starts no
 * update send (the cron's mandate admits no `recurring.update`): landed steps finish, a pending
 * step keeps the attempt in flight, a dropped one unwinds, an unsent one fails the update back to
 * `active` on its old terms with an error log, and the old subscription's cancel (an exit) is
 * still sent. A replacement that never reached its plan fails back at once.
 *
 * @param input - The stale schedule and its source wallet pin.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The schedule's source wallet pin.
 * @param input.recurringPayment - The stale `updating` schedule as listed.
 * @returns The schedule once the update finished.
 * @throws RecurringPaymentStepFailedError once the update failed back to `active` (an unsent step
 *   it does not send, a dropped step, or a step that cannot land).
 * @throws AppError CONFLICT when another run holds or finished the update, or a step is pending.
 */
export async function resumeRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<PaymentRecurringPaymentRow> {
  if (!isUpdatingRecurringPaymentStatus(input.recurringPayment.status)) {
    throw internalError(
      `Recurring payment update cannot resume from ${input.recurringPayment.status}`
    );
  }
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const inFlightAttempt = await requireResumedUpdateAttempt(recurringRepo, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
  });
  const terms = await resumedUpdateTerms({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    attempt: inFlightAttempt,
  });
  const settled = await recoverOrBlockLifecycleCollection({
    env: input.env,
    recurringRepo,
    subscriptionsRepo: createPaymentSubscriptionsRepository(input.env, createTenantScope(input)),
    paymentsRepo: createPaymentsRepository(input.env, createTenantScope(input)),
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
  });

  const nowIso = new Date().toISOString();
  const claimResult = await getDb(input.env).transaction(async (tx) => {
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentUpdate({
      recurringPaymentId: settled.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: nowIso,
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
      activatedBy: null,
    });
    if (!claimed) return null;
    const attempt = await requireResumedUpdateAttempt(transactionRepo, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: claimed.id,
    });
    if (attempt.id !== inFlightAttempt.id || attempt.new_plan_id !== inFlightAttempt.new_plan_id) {
      throw conflict("Recurring payment update changed before it was resumed");
    }
    return { claimed, attempt };
  });
  if (!claimResult) {
    throw conflict("Recurring payment update is already processing");
  }
  const { claimed, attempt } = claimResult;

  if (terms === null) {
    const stepFailure = new RecurringPaymentStepFailedError({
      failure: refuseCronUpdateStepSend({
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      }),
      slot: { row: "update_attempt", column: "plan_creation_signature" },
      droppedSignature: null,
    });
    await failRecurringPaymentUpdate({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      claimed,
      attempt,
      stepFailure,
    });
    throw stepFailure;
  }

  return runClaimedRecurringPaymentUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    claimed,
    attempt,
    subscription: settled.subscription,
    mode: attempt.mode,
    resolved: terms.resolved,
    requestedNextCollectionDueAt: terms.requestedNextCollectionDueAt,
    createdBy: attempt.created_by,
    idempotency: null,
    starts: { allowed: false },
  });
}
