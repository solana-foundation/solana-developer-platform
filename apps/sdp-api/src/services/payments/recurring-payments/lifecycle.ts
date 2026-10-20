import {
  decideRecurringPaymentLifecycleTransition,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  type RecurringPaymentLifecycleOperation,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import type { MovementId } from "@sdp/types/movements";
import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isPendingActivationRecurringPaymentStatus,
} from "@sdp/types/payments";
import type { Address, Instruction, MaybeAccount, Signature, TransactionSigner } from "@solana/kit";
import type { SubscriptionDelegation } from "@solana/subscriptions";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentLifecycleAttemptRow,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type { PaymentSubscriptionRow } from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { conflict, internalError, notFound } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  delegationCanceledEffect,
  delegationResumedEffect,
  fenceRecurringPaymentStepFailure,
  insideRecurringPaymentStepPhase,
  journalInFlightRecurringPaymentAttempt,
  lazyRecurringPaymentStepSigner,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  type RecurringPaymentSourceWallet,
  RecurringPaymentStepFailedError,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  readSavedRecurringPaymentStep,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
  sendRecurringPaymentStep,
} from "./shared";

/** The movement each lifecycle operation signs for: cancel is an exit, resume a start. */
const LIFECYCLE_MOVEMENTS = {
  cancel: "recurring.cancel",
  resume: "recurring.resume",
} as const satisfies Record<RecurringPaymentLifecycleOperation, MovementId>;

function lifecycleConfirmationMessage(operation: RecurringPaymentLifecycleOperation) {
  return operation === "cancel"
    ? "Recurring payment cancellation failed on-chain"
    : "Recurring payment resume failed on-chain";
}

/**
 * Resume signs over the delegation's current expiry, so the program refuses a
 * stale resume. The caller reads the delegation once and passes it.
 */
async function buildResumeInstruction(input: {
  planPda: Address;
  subscriber: TransactionSigner;
  subscriptionPda: Address;
  tokenMint: Address;
  onChainSubscription: MaybeAccount<SubscriptionDelegation>;
}): Promise<Instruction> {
  if (!input.onChainSubscription.exists) {
    throw conflict("Subscription was not found on-chain");
  }
  return subscriptionsProgram.getResumeSubscriptionOverlayInstructionAsync({
    expectedExpiresAtTs: input.onChainSubscription.data.expiresAtTs,
    planPda: input.planPda,
    subscriber: input.subscriber,
    subscriptionPda: input.subscriptionPda,
    tokenMint: input.tokenMint,
  });
}

function assertLifecyclePreconditions(input: {
  operation: RecurringPaymentLifecycleOperation;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: RecurringPaymentSourceWallet;
  nowIso: string;
}): void {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);

  const transition = decideRecurringPaymentLifecycleTransition({
    operation: input.operation,
    status: input.recurringPayment.status,
    updatedAt: input.recurringPayment.updated_at,
    nowIso: input.nowIso,
  });
  if (
    transition === "already_final" ||
    transition === "claimable" ||
    transition === "recoverable"
  ) {
    return;
  }
  if (transition === "processing") {
    throw conflict(`Recurring payment ${input.operation} is already processing`);
  }
  throw conflict(
    `Recurring payment cannot be ${input.operation === "cancel" ? "canceled" : "resumed"} from this status`
  );
}

async function getOrCreateLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  nowIso: string;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentLifecycleAttemptRow> {
  const existing = await input.recurringRepo.getLatestLifecycleAttempt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    operation: input.operation,
    statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  });

  if (existing) {
    // A stale claim resumes the in-flight attempt under its original key, or
    // records this request's key on it when it has none (same transaction).
    // An attempt another key answers for is that request's: finishing it here
    // would leave this key with no attempt, so a retry once its record expires
    // would run again. It is refused as in flight, unstored, and the
    // transaction rolls the claim back; the cron finishes the attempt (as
    // collect does).
    if (
      input.idempotencyKey !== null &&
      existing.idempotency_key !== null &&
      existing.idempotency_key !== input.idempotencyKey
    ) {
      throw conflict(`Recurring payment ${input.operation} is already processing`);
    }
    if (input.idempotencyKey === null || existing.idempotency_key !== null) {
      return existing;
    }
    const adopted = await input.recurringRepo.updateLifecycleAttempt({
      attemptId: existing.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      adoptIdempotencyKey: input.idempotencyKey,
      updatedAt: input.nowIso,
    });
    if (adopted === null) {
      throw conflict("Recurring payment lifecycle attempt changed concurrently");
    }
    return adopted;
  }

  const attempt = await input.recurringRepo.createLifecycleAttempt({
    id: `prpl_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    operation: input.operation,
    status: "processing",
    stage: "claim",
    signature: null,
    error: null,
    metadata: {},
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    idempotencyKey: input.idempotencyKey,
  });
  if (!attempt) {
    throw internalError("Failed to journal recurring payment lifecycle");
  }
  return attempt;
}

/**
 * A keyed request for a schedule already in the operation's final state runs
 * nothing, but its key is still answered: a confirmed attempt records it, so a
 * retry once the key's shared record has expired is answered from the attempt
 * instead of running the operation on a schedule that has moved on since (a
 * cancel after a later resume). The cron (no key) records nothing.
 */
async function answerFinalLifecycle(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.idempotencyKey === null) {
    return input.recurringPayment;
  }
  const answeredAt = new Date().toISOString();
  const attempt = await input.recurringRepo.createLifecycleAttempt({
    id: `prpl_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    operation: input.operation,
    status: "confirmed",
    stage: "finalize",
    signature: null,
    error: null,
    metadata: {},
    createdAt: answeredAt,
    updatedAt: answeredAt,
    idempotencyKey: input.idempotencyKey,
  });
  if (!attempt) {
    throw internalError(`Failed to journal recurring payment ${input.operation}`);
  }
  return input.recurringPayment;
}

/**
 * Fails a lifecycle operation whose step cannot land, in one transaction: fences the step's slot
 * (a dropped signature is cleared while the slot still holds it; otherwise the slot must still be
 * empty), fails the attempt (its stage stays where the run
 * left it), and moves the schedule from the operation's processing status back to the one it was
 * claimed from (`canceling` to `active`, `resuming` to `canceled`). The attempt write is fenced to
 * `processing` and the schedule write to the processing status.
 *
 * @param input - The run's attempt, operation and step failure.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.operation - The lifecycle operation.
 * @param input.attempt - The run's attempt.
 * @param input.stepFailure - The step failure.
 * @throws AppError CONFLICT when the slot fence fails, the attempt is no longer `processing`, or
 *   the schedule left the processing status; the transaction rolls back
 *   and the attempt stays in flight.
 */
async function recordLifecycleFailure(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  operation: RecurringPaymentLifecycleOperation;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  stepFailure: RecurringPaymentStepFailedError;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  const { claimableStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
    input.operation
  );
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    await fenceRecurringPaymentStepFailure({
      recurringRepo,
      attemptId: input.attempt.id,
      recurringPaymentId: input.attempt.recurring_payment_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stepFailure: input.stepFailure,
      updatedAt: failedAt,
    });
    requireUpdatedAttempt(
      await recurringRepo.updateLifecycleAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        error: recurringPaymentErrorMessage(input.stepFailure.failure),
        expectedStatus: "processing",
        updatedAt: failedAt,
      })
    );
    const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.attempt.recurring_payment_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: claimableStatus,
      expectedStatus: processingStatus,
      updatedAt: failedAt,
    });
    if (updatedRecurringPayment === null) {
      throw conflict("Recurring payment lifecycle changed concurrently");
    }
  });
}

async function finalizeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  operation: RecurringPaymentLifecycleOperation;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  /** Null when an earlier run's send landed before it saved the signature. */
  signature: Signature | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  const { finalStatus: recurringStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
    input.operation
  );
  const subscriptionStatus = input.operation === "cancel" ? "canceled" : "active";

  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    const updatedSubscription = await subscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: subscriptionStatus,
      cancelAt: input.operation === "cancel" ? finalizedAt : null,
      canceledAt: input.operation === "cancel" ? finalizedAt : null,
      updatedAt: finalizedAt,
    });
    const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: recurringStatus,
      expectedStatus: processingStatus,
      updatedAt: finalizedAt,
    });
    const updatedAttempt = await recurringRepo.updateLifecycleAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: "finalize",
      signature: input.signature,
      error: null,
      expectedStatus: "processing",
      updatedAt: finalizedAt,
    });
    if (updatedAttempt === null) {
      throw conflict("Recurring payment lifecycle attempt changed concurrently");
    }

    if (
      !updatedSubscription ||
      updatedSubscription.status !== subscriptionStatus ||
      !updatedRecurringPayment ||
      updatedRecurringPayment.status !== recurringStatus ||
      updatedAttempt.status !== "confirmed" ||
      updatedAttempt.signature !== input.signature
    ) {
      throw internalError("Failed to finalize recurring payment lifecycle");
    }

    return updatedRecurringPayment;
  });
}

/**
 * Resume starts money movement again, so it runs money admission (HOO-1955)
 * before it signs. Cancel is an exit and is never refused (ADR 0002).
 */
type RecurringPaymentLifecycleRun =
  | {
      operation: Extract<RecurringPaymentLifecycleOperation, "cancel">;
      /**
       * The caller's own refusal of a cancel it may not sign (wallet scope),
       * run before the claim. Null for the job, which cancels as the mandate,
       * and for revocation, which signs as the person revoking, whom wallet
       * scope never narrows. A cancel is an exit: this is the waist's refusal
       * made early, so a refused request claims and journals nothing (HOO-2099).
       */
      admitCaller: (() => void) | null;
    }
  | {
      operation: Extract<RecurringPaymentLifecycleOperation, "resume">;
      admitStart: () => Promise<void>;
    };

async function runRecurringPaymentLifecycle(
  input: {
    env: Env;
    organizationId: string;
    projectId: string;
    sourceWallet: RecurringPaymentSourceWallet;
    recurringPayment: PaymentRecurringPaymentRow;
    /** The request's Idempotency-Key, written on the attempt it claims; null for the cron. */
    idempotencyKey: string | null;
  } & RecurringPaymentLifecycleRun
): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const paymentsRepo = createPaymentsRepository(input.env, createTenantScope(input));
  const nowIso = new Date().toISOString();

  assertLifecyclePreconditions({ ...input, nowIso });
  if (
    input.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).finalStatus
  ) {
    return answerFinalLifecycle({
      ...input,
      recurringRepo,
      recurringPayment: input.recurringPayment,
    });
  }

  const collectionState =
    input.operation === "cancel"
      ? { recurringPayment: input.recurringPayment, subscription: null }
      : await recoverOrBlockLifecycleCollection({
          env: input.env,
          recurringRepo,
          subscriptionsRepo,
          paymentsRepo,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: input.recurringPayment,
        });

  assertLifecyclePreconditions({
    operation: input.operation,
    recurringPayment: collectionState.recurringPayment,
    sourceWallet: input.sourceWallet,
    nowIso: new Date().toISOString(),
  });
  if (
    collectionState.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).finalStatus
  ) {
    return answerFinalLifecycle({
      ...input,
      recurringRepo,
      recurringPayment: collectionState.recurringPayment,
    });
  }

  // A fresh run is refused before its claim when the wallet cannot sign, and a fresh resume is
  // admitted before its claim commits: the job recovers a claimed resume as its mandate, so a
  // claim must never exist for a caller the waist would refuse (HOO-2099). A stale run is neither:
  // its saved step is read first, and the lazy signer decides just before a new send, so a step
  // the chain shows landed finishes.
  const recoveringStaleLifecycle =
    collectionState.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).processingStatus;
  if (!recoveringStaleLifecycle) {
    await createSigningService(input.env).admitRuntimeExecution(
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    );
  }
  if (input.operation === "resume" && !recoveringStaleLifecycle) {
    await input.admitStart();
  }
  if (input.operation === "cancel") {
    input.admitCaller?.();
  }

  // A resume starts the mandate again; a cancel records nobody.
  const activatedBy = input.operation === "resume" ? currentMandateActivator() : null;
  const claimResult = await getDb(input.env).transaction(async (tx) => {
    await lockLiveActivatingKey(tx, {
      activator: activatedBy,
      organizationId: input.organizationId,
      projectId: input.projectId,
      movement: "recurring.resume",
      recurringPaymentId: collectionState.recurringPayment.id,
      custodyWalletIds: [input.sourceWallet.id],
    });
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentLifecycle({
      recurringPaymentId: collectionState.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: input.operation,
      updatedAt: new Date().toISOString(),
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
      activatedBy,
    });
    if (!claimed) return null;
    const attempt = await getOrCreateLifecycleAttempt({
      recurringRepo: transactionRepo,
      claimed,
      operation: input.operation,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
      idempotencyKey: input.idempotencyKey,
    });
    return { claimed, attempt };
  });

  if (!claimResult) {
    throw conflict(`Recurring payment ${input.operation} is already processing`);
  }
  const { claimed, attempt } = claimResult;
  const slot = { row: "lifecycle_attempt", column: "signature" } as const;
  const savedSignature = parseNullableStoredSignature(attempt.signature);
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: savedSignature === null ? null : slot.column,
    step: slot,
  };
  const failureMessage = lifecycleConfirmationMessage(input.operation);
  const sourceSigner = lazyRecurringPaymentStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    movement: LIFECYCLE_MOVEMENTS[input.operation],
    admitRecovered:
      recoveringStaleLifecycle && input.operation === "resume" ? input.admitStart : null,
    logContext: { recurring_payment_id: claimed.id, attempt_id: attempt.id },
  });

  const lifecycleStep = async () => {
    if (!claimed.plan_pda || !claimed.subscription_id || !claimed.subscription_pda) {
      throw conflict("Recurring payment is missing on-chain subscription records");
    }

    const subscription =
      collectionState.subscription?.id === claimed.subscription_id
        ? collectionState.subscription
        : await subscriptionsRepo.getSubscriptionById({
            subscriptionId: claimed.subscription_id,
            organizationId: input.organizationId,
            projectId: input.projectId,
          });
    if (!subscription) {
      throw notFound("Subscription");
    }
    const plan = await subscriptionsRepo.getPlanById({
      planId: subscription.plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!plan) {
      throw notFound("Subscription plan");
    }
    const tokenMint = assertValidAddress(
      await assertRecurringPaymentTokenMint(
        plan.token,
        input.organizationId,
        input.projectId,
        input.env
      ),
      "tokenMint"
    );

    const expectedSubscriptionStatus = input.operation === "cancel" ? "active" : "canceled";
    const finalSubscriptionStatus = input.operation === "cancel" ? "canceled" : "active";
    if (
      subscription.status !== expectedSubscriptionStatus &&
      subscription.status !== finalSubscriptionStatus
    ) {
      throw conflict(
        `Subscription cannot be ${input.operation === "cancel" ? "canceled" : "resumed"} from this status`
      );
    }

    const planPda = assertValidAddress(claimed.plan_pda, "planPda");
    const subscriptionPda = assertValidAddress(claimed.subscription_pda, "subscriptionPda");
    const effect =
      input.operation === "cancel"
        ? delegationCanceledEffect(subscriptionPda)
        : delegationResumedEffect(subscriptionPda);
    const logContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: claimed.id,
      attempt_id: attempt.id,
      step: input.operation,
    };
    // A signature saved in the slot means an earlier run reached the send (HOO-2044): the chain
    // settles it before anything is sent again.
    if (savedSignature !== null) {
      await readSavedRecurringPaymentStep({
        phase,
        slot,
        signature: savedSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect,
        failureMessage,
        logContext,
      });
      return { subscription, signature: savedSignature };
    }

    const signer = await sourceSigner();
    requireUpdatedAttempt(
      await recurringRepo.updateLifecycleAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "submit",
        error: null,
        updatedAt: new Date().toISOString(),
      })
    );

    const instruction =
      input.operation === "cancel"
        ? await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
            planPda,
            subscriber: signer,
            subscriptionPda,
          })
        : await buildResumeInstruction({
            planPda,
            subscriber: signer,
            subscriptionPda,
            tokenMint,
            onChainSubscription: await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
              createClusterRpc(),
              subscriptionPda,
              { commitment: "confirmed" }
            ),
          });
    const settled = await sendRecurringPaymentStep({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: claimed.id,
      attemptId: attempt.id,
      movement: LIFECYCLE_MOVEMENTS[input.operation],
      sourceWallet: input.sourceWallet,
      sourceSigner: signer,
      instructions: [instruction],
      slot,
      effect,
      alreadyDone: {
        code:
          input.operation === "cancel"
            ? subscriptionsProgram.SUBSCRIPTIONS_ERROR__SUBSCRIPTION_ALREADY_CANCELLED
            : subscriptionsProgram.SUBSCRIPTIONS_ERROR__SUBSCRIPTION_NOT_CANCELLED,
        notLanded: "pending",
      },
      onFailure: { outcome: "unwind" },
      failureMessage,
      logContext,
    });
    return { subscription, signature: settled.signature };
  };

  try {
    const settled = await insideRecurringPaymentStepPhase(phase, lifecycleStep, null);
    return await finalizeRecurringPaymentLifecycle({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: input.operation,
      recurringPayment: claimed,
      subscription: settled.subscription,
      attempt,
      signature: settled.signature,
    });
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
      "Recurring payment lifecycle operation failed"
    );
    if (stepFailure !== null) {
      await recordLifecycleFailure({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        operation: input.operation,
        attempt,
        stepFailure,
      });
      throw stepFailure.failure;
    }
    // Anything else may leave a step in flight: the attempt keeps its status and records only
    // the error, so a concurrent finalize is never flipped back.
    await journalInFlightRecurringPaymentAttempt({
      write: () =>
        recurringRepo.updateLifecycleAttempt({
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

export async function cancelRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  /** The request's Idempotency-Key, written on the attempt; null for the cron. */
  idempotencyKey: string | null;
  /** See RecurringPaymentLifecycleRun; a cancel before activation signs nothing, so skips it. */
  admitCaller: (() => void) | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    return cancelPendingRecurringPayment(input);
  }
  return runRecurringPaymentLifecycle({ ...input, operation: "cancel" });
}

/**
 * Cancels a schedule that never went on chain. The status change and a
 * confirmed cancel attempt carrying the request's key commit together, so a
 * retry of the same request is answered from the attempt (HOO-1918).
 */
async function cancelPendingRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const canceledAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const updated = await recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "canceled",
      expectedStatus: "pending_activation",
      updatedAt: canceledAt,
    });
    if (!updated) {
      throw conflict("Recurring payment status changed before it could be canceled");
    }
    const attempt = await recurringRepo.createLifecycleAttempt({
      id: `prpl_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      operation: "cancel",
      status: "confirmed",
      stage: "finalize",
      signature: null,
      error: null,
      metadata: {},
      createdAt: canceledAt,
      updatedAt: canceledAt,
      idempotencyKey: input.idempotencyKey,
    });
    if (!attempt) {
      throw internalError("Failed to journal recurring payment cancellation");
    }
    return updated;
  });
}

export async function resumeRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  /** Money admission (HOO-1955), run only if the resume still has to sign. */
  admitStart: () => Promise<void>;
  /** The request's Idempotency-Key, written on the attempt; null for the cron. */
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  return runRecurringPaymentLifecycle({ ...input, operation: "resume" });
}
