import {
  decideRecurringPaymentLifecycleTransition,
  firstRecurringPaymentDueAfter,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  nextRecurringPaymentCollectionDueAt,
  type RecurringPaymentLifecycleOperation,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isPendingActivationRecurringPaymentStatus,
  isRecurringPaymentLifecycleClaimableStatus,
  type PaymentRecurringPaymentLifecycleAttemptStage,
  type PaymentRecurringPaymentStatus,
  RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS,
} from "@sdp/types/payments";
import type { Address, MaybeAccount, Signature } from "@solana/kit";
import type { SubscriptionDelegation } from "@solana/subscriptions";
import * as subscriptionsProgram from "@solana/subscriptions";
import { z } from "zod";
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
} from "@/db/repositories/repository-factory";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { revokeSubscriptionAuthorityAfterCancel } from "./authority-revocation";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTerms,
  confirmSubscriptionSignature,
  createSubscriptionStepStore,
  isSubscriptionDelegationCanceled,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  recurringPaymentErrorMessage,
  type SubscriptionStep,
  savedStepSend,
  sendSubscriptionInstructions,
} from "./shared";

/** Cancel is an exit: money admission never refuses it (ADR 0002). */
const CANCEL_MOVEMENT = "recurring.cancel";
const CANCEL_FAILED_MESSAGE = "Recurring payment cancellation failed on-chain";

/**
 * What a cancel attempt records about its claim (HOO-2340): the status it claimed the schedule
 * from, so a cancel that definitely failed puts a paused schedule back to paused and a running one
 * back to active.
 */
const cancelAttemptMetadataSchema = z.object({
  claimedFrom: z.enum(RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS.cancel.claimableStatuses),
});

function assertLifecyclePreconditions(input: {
  operation: RecurringPaymentLifecycleOperation;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
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

/**
 * The cancel attempt a claim runs under: the in-flight one a stale claim resumes, or a new one
 * recording the status the schedule was claimed from. Runs inside the claim's transaction, so a
 * failure here rolls the claim back with it.
 *
 * @param input.recurringRepo - The claim transaction's repository.
 * @param input.claimed - The schedule as claimed (`canceling`).
 * @param input.claimedFrom - Its status before the claim.
 * @param input.organizationId - Tenant organization.
 * @param input.projectId - Tenant project.
 * @param input.nowIso - Claim time.
 * @param input.idempotencyKey - The request's key, or null for the cron.
 * @returns The attempt to run.
 */
async function getOrCreateCancelAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  claimedFrom: PaymentRecurringPaymentStatus;
  organizationId: string;
  projectId: string;
  nowIso: string;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentLifecycleAttemptRow> {
  const existing = await input.recurringRepo.getLatestLifecycleAttempt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    operation: "cancel",
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
      throw conflict("Recurring payment cancel is already processing");
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

  // Only a fresh claim reaches here: a stale `canceling` claim always has the
  // in-flight attempt its own claim wrote in the same transaction.
  if (!isRecurringPaymentLifecycleClaimableStatus("cancel", input.claimedFrom)) {
    throw internalError("A recurring payment cancel claim has no in-flight attempt");
  }
  const attempt = await input.recurringRepo.createLifecycleAttempt({
    id: `prpl_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    operation: "cancel",
    status: "processing",
    stage: "claim",
    signature: null,
    error: null,
    metadata: { claimedFrom: input.claimedFrom },
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
 * instead of running the operation on a schedule that has moved on since. The
 * cron (no key) records nothing.
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
 * Fails a cancel attempt nothing it sent can still land on, and puts the schedule back to the
 * status its claim took it from, in one transaction.
 */
async function recordCancelFailure(input: {
  env: Env;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  organizationId: string;
  projectId: string;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  error: Error;
  failedAt: string;
}): Promise<void> {
  const { claimedFrom } = cancelAttemptMetadataSchema.parse(input.attempt.metadata);
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const updatedAttempt = await recurringRepo.updateLifecycleAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "failed",
      stage: input.stage,
      error: recurringPaymentErrorMessage(input.error),
      updatedAt: input.failedAt,
    });
    if (updatedAttempt === null)
      throw conflict("Recurring payment lifecycle attempt changed concurrently");

    const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.attempt.recurring_payment_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: claimedFrom,
      expectedStatus: RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS.cancel.processingStatus,
      updatedAt: input.failedAt,
    });
    if (updatedRecurringPayment === null)
      throw conflict("Recurring payment lifecycle changed concurrently");
  });
}

async function preserveRecoverableLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  /** Null when the chain shows the operation but this run never had its signature. */
  signature: Signature | null;
  error: Error;
  failedAt: string;
  confirmedOnChain: boolean;
}): Promise<void> {
  try {
    await input.recurringRepo.updateLifecycleAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: input.stage,
      signature: input.signature,
      error: recurringPaymentErrorMessage(input.error),
      updatedAt: input.failedAt,
    });
  } catch (journalError) {
    if (!(journalError instanceof Error)) throw journalError;
    getLogger().error(
      {
        error: recurringPaymentErrorMessage(journalError),
        operation: "cancel",
        recurring_payment_id: input.recurringPaymentId,
      },
      "Failed to preserve recoverable recurring payment lifecycle attempt"
    );
  }

  getLogger().error(
    {
      confirmed_on_chain: input.confirmedOnChain,
      error: recurringPaymentErrorMessage(input.error),
      operation: "cancel",
      recurring_payment_id: input.recurringPaymentId,
    },
    "Recurring payment lifecycle left recoverable after submission"
  );
}

async function finalizeRecurringPaymentCancel(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  /** Null when an earlier run's send landed before it saved the signature. */
  signature: Signature | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  const { finalStatus: recurringStatus, processingStatus } =
    getRecurringPaymentLifecycleStatuses("cancel");
  const subscriptionStatus = "canceled";

  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    const updatedSubscription = await subscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: subscriptionStatus,
      cancelAt: finalizedAt,
      canceledAt: finalizedAt,
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
      updatedAt: finalizedAt,
    });

    if (
      !updatedSubscription ||
      updatedSubscription.status !== subscriptionStatus ||
      !updatedRecurringPayment ||
      updatedRecurringPayment.status !== recurringStatus ||
      !updatedAttempt ||
      updatedAttempt.status !== "confirmed" ||
      updatedAttempt.signature !== input.signature
    ) {
      throw internalError("Failed to finalize recurring payment lifecycle");
    }

    return updatedRecurringPayment;
  });
}

/**
 * Finalizes a cancel that landed. A cancel is terminal (HOO-2339), so it then revokes the
 * subscription authority the schedule used when no other live schedule on the same wallet and mint
 * needs it; otherwise the authority stays for the sweep. The revoke runs once the cancel has
 * committed and never fails it.
 *
 * @param input - What {@link finalizeRecurringPaymentCancel} takes, plus the revoke's signer.
 * @param input.sourceWallet - The schedule's custody wallet, which granted the authority.
 * @param input.tokenMint - The mint the authority is for.
 * @returns The canceled recurring payment.
 */
async function finalizeCancelAndReleaseAuthority(
  input: Parameters<typeof finalizeRecurringPaymentCancel>[0] & {
    sourceWallet: CustodyWallet;
    tokenMint: Address;
  }
): Promise<PaymentRecurringPaymentRow> {
  const finalized = await finalizeRecurringPaymentCancel(input);
  const authorityAddress = input.subscription.subscription_authority_address;
  if (authorityAddress !== null) {
    await revokeSubscriptionAuthorityAfterCancel(input.env, {
      organization_id: input.organizationId,
      project_id: input.projectId,
      custody_wallet_id: input.sourceWallet.id,
      wallet_address: input.sourceWallet.publicKey,
      token: input.tokenMint,
      subscription_authority_address: authorityAddress,
    });
  }
  return finalized;
}

/**
 * Cancels a schedule that went on chain, running or paused: claims it as `canceling`, signs the
 * Subscriptions cancel as an exit (money admission never refuses it, ADR 0002; an API key's wallet
 * scope bounds it at the route's authorize step, HOO-2337), and finalizes it once it lands. A
 * stale claim settles from the chain first.
 */
async function runRecurringPaymentCancel(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  /** The request's Idempotency-Key, written on the attempt it claims; null for the cron. */
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const nowIso = new Date().toISOString();

  assertLifecyclePreconditions({ ...input, operation: "cancel", nowIso });
  if (
    input.recurringPayment.status === getRecurringPaymentLifecycleStatuses("cancel").finalStatus
  ) {
    return answerFinalLifecycle({
      ...input,
      operation: "cancel",
      recurringRepo,
      recurringPayment: input.recurringPayment,
    });
  }

  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );

  const claimResult = await getDb(input.env).transaction(async (tx) => {
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentLifecycle({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: "cancel",
      updatedAt: new Date().toISOString(),
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
      // A cancel records nobody.
      activatedBy: null,
    });
    if (!claimed) return null;
    const attempt = await getOrCreateCancelAttempt({
      recurringRepo: transactionRepo,
      claimed,
      claimedFrom: input.recurringPayment.status,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
      idempotencyKey: input.idempotencyKey,
    });
    return { claimed, attempt };
  });

  if (!claimResult) {
    throw conflict("Recurring payment cancel is already processing");
  }
  const { claimed } = claimResult;
  let { attempt } = claimResult;

  let currentStage: PaymentRecurringPaymentLifecycleAttemptStage = attempt.stage;
  let signature = parseNullableStoredSignature(attempt.signature);
  let confirmedOnChain = false;
  // An attempt an earlier run left at `submit` reached the send, saved or not
  // (HOO-2044). Claiming it took the stale window, so the chain settles it.
  const resumedAtSubmit = attempt.stage === "submit";

  try {
    if (!claimed.plan_pda || !claimed.subscription_id || !claimed.subscription_pda) {
      throw conflict("Recurring payment is missing on-chain subscription records");
    }

    const subscription = await subscriptionsRepo.getSubscriptionById({
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
    const tokenMint = assertValidAddress(plan.token, "tokenMint");

    if (subscription.status !== "active" && subscription.status !== "canceled") {
      throw conflict("Subscription cannot be canceled from this status");
    }

    const planPda = assertValidAddress(claimed.plan_pda, "planPda");
    const subscriptionPda = assertValidAddress(claimed.subscription_pda, "subscriptionPda");
    const rpc = createClusterRpc();
    const readDelegation = (commitment: "finalized" | "confirmed") =>
      subscriptionsProgram.fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, { commitment });
    const lifecycleStep = {
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rows: [{ slot: { row: "lifecycle_attempt", column: "signature" }, id: attempt.id }],
    } as const satisfies SubscriptionStep;
    if (resumedAtSubmit) {
      const step = await readRecurringPaymentStep({
        rpc,
        read: readDelegation,
        landed: (delegation: MaybeAccount<SubscriptionDelegation>) =>
          delegation.exists && isSubscriptionDelegationCanceled(delegation),
        savedSend: savedStepSend(signature, attempt.last_valid_block_height),
        step: lifecycleStep,
        failureMessage: CANCEL_FAILED_MESSAGE,
        logContext: {
          recurring_payment_id: claimed.id,
          attempt_id: attempt.id,
          step: "cancel",
        },
      });
      if (step.kind === "landed") {
        confirmedOnChain = true;
        return await finalizeCancelAndReleaseAuthority({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: claimed,
          subscription,
          attempt,
          signature,
          sourceWallet: input.sourceWallet,
          tokenMint,
        });
      }
      signature = null;
    }

    const sourceSigner = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id,
      CANCEL_MOVEMENT
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    currentStage = "submit";
    await recurringRepo.updateLifecycleAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: currentStage,
      updatedAt: new Date().toISOString(),
    });

    const instruction = await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
      planPda,
      subscriber: sourceSigner,
      subscriptionPda,
    });

    signature = await sendSubscriptionInstructions({
      movement: CANCEL_MOVEMENT,
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      sourceSigner,
      instructions: [instruction],
      submissionStore: createSubscriptionStepStore({
        ...lifecycleStep,
        save: async (send) => {
          const updatedAttempt = await recurringRepo.updateLifecycleAttempt({
            attemptId: attempt.id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            stage: currentStage,
            signature: send.signature,
            lastValidBlockHeight: send.lastValidBlockHeight,
            error: null,
            updatedAt: new Date().toISOString(),
          });
          if (updatedAttempt === null) {
            throw conflict("Recurring payment lifecycle attempt changed concurrently");
          }
          attempt = updatedAttempt;
          signature = send.signature;
        },
      }),
    });

    await confirmSubscriptionSignature(signature, CANCEL_FAILED_MESSAGE);
    confirmedOnChain = true;

    return finalizeCancelAndReleaseAuthority({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: claimed,
      subscription,
      attempt,
      signature,
      sourceWallet: input.sourceWallet,
      tokenMint,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    getLogger().error(
      {
        err: error,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment lifecycle operation failed"
    );
    const failedAt = new Date().toISOString();
    // Failed on chain, or refused at preflight (its saved signature already cleared).
    const definitelyFailed = isDefiniteSubmissionError(error);

    // Once the operation is on chain, or may be, a failure only leaves the attempt to finish.
    if (
      (signature || confirmedOnChain || error instanceof ResumedStepUnsettledError) &&
      !definitelyFailed
    ) {
      await preserveRecoverableLifecycleAttempt({
        recurringRepo,
        attempt,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: claimed.id,
        stage: currentStage,
        signature,
        error,
        failedAt,
        confirmedOnChain,
      });
      throw error;
    }

    try {
      await recordCancelFailure({
        env: input.env,
        attempt,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        error,
        failedAt,
      });
    } catch (resetError) {
      getLogger().error(
        {
          error: resetError instanceof Error ? resetError.message : String(resetError),
          operation: "cancel",
          recurring_payment_id: claimed.id,
        },
        "Failed to journal/reset recurring payment lifecycle after failure"
      );
    }

    throw error;
  }
}

export async function cancelRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  /** The request's Idempotency-Key, written on the attempt; null for the cron. */
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    return cancelPendingRecurringPayment(input);
  }
  return runRecurringPaymentCancel(input);
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

/**
 * The due date a resumed schedule collects next: its paused one while that period is still open,
 * or the first boundary after now once it has passed, since an elapsed period is never caught up.
 *
 * @param dueAt - The due date the schedule paused at.
 * @param periodHours - The schedule's period.
 * @param now - Resume time.
 * @returns The due date to resume at.
 */
function resumedCollectionDueAt(dueAt: string, periodHours: number, now: Date): string {
  return new Date(nextRecurringPaymentCollectionDueAt(dueAt, periodHours)).getTime() > now.getTime()
    ? dueAt
    : firstRecurringPaymentDueAfter(dueAt, periodHours, now);
}

/**
 * Resumes a schedule SDP paused after its collections kept failing (HOO-2340). Its delegation is
 * still on chain, so nothing is signed: one transaction moves it `paused` to `active` under
 * compare-and-set, records who resumed it as its activator, moves an elapsed due date to the next
 * boundary, and writes a confirmed resume attempt carrying the request's key. Resume starts money
 * movement again, so token terms, the wallet's runtime permission and money admission (HOO-1955)
 * all run before anything is written, and the resuming key is re-read under lock (HOO-2099).
 * The collection failures counted toward the next pause start again from here.
 *
 * @param input.env - Runtime environment.
 * @param input.organizationId - Tenant organization.
 * @param input.projectId - Tenant project.
 * @param input.sourceWallet - The schedule's custody wallet.
 * @param input.recurringPayment - The schedule as read.
 * @param input.admitStart - Money admission for `recurring.resume`.
 * @param input.idempotencyKey - The request's key, written on the resume attempt.
 * @returns The resumed recurring payment.
 */
export async function resumeRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  admitStart: () => Promise<void>;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const { recurringPayment } = input;
  assertRecurringPaymentSourceWallet(recurringPayment, input.sourceWallet);
  if (recurringPayment.status === getRecurringPaymentLifecycleStatuses("resume").finalStatus) {
    return answerFinalLifecycle({
      ...input,
      operation: "resume",
      recurringRepo: createPaymentRecurringPaymentsRepository(input.env, createTenantScope(input)),
    });
  }
  if (!isRecurringPaymentLifecycleClaimableStatus("resume", recurringPayment.status)) {
    throw conflict("Recurring payment cannot be resumed from this status");
  }
  const subscriptionId = recurringPayment.subscription_id;
  const currentDueAt = recurringPayment.next_collection_due_at;
  if (subscriptionId === null || currentDueAt === null) {
    throw conflict("Recurring payment is missing subscription records");
  }

  await assertRecurringPaymentTerms({
    token: recurringPayment.token,
    amount: recurringPayment.amount,
    organizationId: input.organizationId,
    projectId: input.projectId,
    env: input.env,
  });
  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );
  await input.admitStart();

  const activatedBy = currentMandateActivator();
  const now = new Date();
  const resumedAt = now.toISOString();
  const nextDueAt = resumedCollectionDueAt(currentDueAt, recurringPayment.period_hours, now);
  return getDb(input.env).transaction(async (tx) => {
    await lockLiveActivatingKey(tx, {
      activator: activatedBy,
      organizationId: input.organizationId,
      projectId: input.projectId,
      movement: "recurring.resume",
      recurringPaymentId: recurringPayment.id,
      custodyWalletIds: [input.sourceWallet.id],
    });
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const resumed = await recurringRepo.resumePausedRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentCollectionDueAt: currentDueAt,
      nextCollectionDueAt: nextDueAt,
      activatedBy,
      updatedAt: resumedAt,
    });
    if (!resumed) {
      throw conflict("Recurring payment changed before it could be resumed");
    }
    if (nextDueAt !== currentDueAt) {
      const subscription = await createPostgresPaymentSubscriptionsRepository(
        tx
      ).updateSubscription({
        subscriptionId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        nextCollectionDueAt: nextDueAt,
        expectedNextCollectionDueAt: currentDueAt,
        expectedStatus: "active",
        updatedAt: resumedAt,
      });
      if (!subscription) {
        throw conflict("Subscription changed before the recurring payment could be resumed");
      }
    }
    const attempt = await recurringRepo.createLifecycleAttempt({
      id: `prpl_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: recurringPayment.id,
      operation: "resume",
      status: "confirmed",
      stage: "finalize",
      signature: null,
      error: null,
      // The pause's failure count starts again after this attempt (collection.ts).
      metadata: { resumedFrom: "paused" },
      createdAt: resumedAt,
      updatedAt: resumedAt,
      idempotencyKey: input.idempotencyKey,
    });
    if (!attempt) {
      throw internalError("Failed to journal recurring payment resume");
    }
    return resumed;
  });
}
