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
  type PaymentRecurringPaymentLifecycleAttemptStage,
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
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  confirmSubscriptionSignature,
  createSubscriptionStepStore,
  isSubscriptionDelegationCanceled,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  recurringPaymentErrorMessage,
  refuseWhileSubscriptionAuthorityRevokes,
  type SubscriptionStep,
  savedStepSend,
  sendSubscriptionInstructions,
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

async function getOrCreateLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  nowIso: string;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentLifecycleAttemptRow> {
  const { claimableStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
    input.operation
  );
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

  let attempt: PaymentRecurringPaymentLifecycleAttemptRow | null = null;
  try {
    attempt = await input.recurringRepo.createLifecycleAttempt({
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
  } catch (error) {
    await input.recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: claimableStatus,
      expectedStatus: processingStatus,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }

  if (!attempt) {
    await input.recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: claimableStatus,
      expectedStatus: processingStatus,
      updatedAt: new Date().toISOString(),
    });
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

async function recordLifecycleFailure(input: {
  env: Env;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  error: Error;
  failedAt: string;
  resetClaim: boolean;
}): Promise<void> {
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

    if (input.resetClaim) {
      const { claimableStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
        input.operation
      );
      const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentLifecycle({
        recurringPaymentId: input.attempt.recurring_payment_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: claimableStatus,
        expectedStatus: processingStatus,
        updatedAt: input.failedAt,
      });
      if (updatedRecurringPayment === null)
        throw conflict("Recurring payment lifecycle changed concurrently");
    }
  });
}

async function preserveRecoverableLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  operation: RecurringPaymentLifecycleOperation;
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
        operation: input.operation,
        recurring_payment_id: input.recurringPaymentId,
      },
      "Failed to preserve recoverable recurring payment lifecycle attempt"
    );
  }

  getLogger().error(
    {
      confirmed_on_chain: input.confirmedOnChain,
      error: recurringPaymentErrorMessage(input.error),
      operation: input.operation,
      recurring_payment_id: input.recurringPaymentId,
    },
    "Recurring payment lifecycle left recoverable after submission"
  );
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Lifecycle recovery keeps each persisted stage explicit.
async function runRecurringPaymentLifecycle(
  input: {
    env: Env;
    organizationId: string;
    projectId: string;
    sourceWallet: CustodyWallet;
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

  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );

  // A fresh resume is admitted before its claim commits: the job recovers a
  // claimed resume as its mandate, so a claim must never exist for a caller
  // the waist would refuse (HOO-2099). A stale one is admitted below, only
  // when it still has to sign.
  const recoveringStaleLifecycle =
    collectionState.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).processingStatus;
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
    // A cancel never touches the authority, and an exit is never held up.
    if (input.operation === "resume") {
      await refuseWhileSubscriptionAuthorityRevokes(tx, {
        projectId: input.projectId,
        custodyWalletIds: [input.sourceWallet.id],
      });
    }
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
    // Cancel is an exit and never asks the token admission check; only resume restarts collection.
    const tokenMint = assertValidAddress(
      input.operation === "resume"
        ? await assertRecurringPaymentTokenMint(
            plan.token,
            input.organizationId,
            input.projectId,
            input.env
          )
        : plan.token,
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
    const rpc = createClusterRpc();
    const readDelegation = (commitment: "finalized" | "confirmed") =>
      subscriptionsProgram.fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, { commitment });
    const lifecycleStep = {
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rows: [{ slot: { row: "lifecycle_attempt", column: "signature" }, id: attempt.id }],
    } as const satisfies SubscriptionStep;
    let onChainSubscription: MaybeAccount<SubscriptionDelegation> | null = null;
    if (resumedAtSubmit) {
      const step = await readRecurringPaymentStep({
        rpc,
        read: readDelegation,
        // Resume clears the expiry, so only an existing delegation shows it landed.
        landed: (delegation) =>
          delegation.exists &&
          isSubscriptionDelegationCanceled(delegation) === (input.operation === "cancel"),
        savedSend: savedStepSend(signature, attempt.last_valid_block_height),
        step: lifecycleStep,
        failureMessage: lifecycleConfirmationMessage(input.operation),
        logContext: {
          recurring_payment_id: claimed.id,
          attempt_id: attempt.id,
          step: input.operation,
        },
      });
      if (step.kind === "landed") {
        confirmedOnChain = true;
        return await finalizeRecurringPaymentLifecycle({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          operation: input.operation,
          recurringPayment: claimed,
          subscription,
          attempt,
          signature,
        });
      }
      onChainSubscription = step.account;
      signature = null;
    }

    // A fresh resume was admitted before its claim. A recovered one is
    // admitted here, only before a new signature: a resumed attempt that the
    // chain shows landed has already returned, so a refusal never strands an
    // operation that is on chain. A refused resume goes back to `canceled`
    // through the failure reset, which matches the subscription on chain.
    if (recoveringStaleLifecycle && input.operation === "resume") {
      await input.admitStart();
    }
    const sourceSigner = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id,
      LIFECYCLE_MOVEMENTS[input.operation]
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

    const instruction =
      input.operation === "cancel"
        ? await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
            planPda,
            subscriber: sourceSigner,
            subscriptionPda,
          })
        : await buildResumeInstruction({
            planPda,
            subscriber: sourceSigner,
            subscriptionPda,
            tokenMint,
            onChainSubscription:
              onChainSubscription === null
                ? await readDelegation("confirmed")
                : onChainSubscription,
          });

    signature = await sendSubscriptionInstructions({
      movement: LIFECYCLE_MOVEMENTS[input.operation],
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

    await confirmSubscriptionSignature(signature, lifecycleConfirmationMessage(input.operation));
    confirmedOnChain = true;

    return finalizeRecurringPaymentLifecycle({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: input.operation,
      recurringPayment: claimed,
      subscription,
      attempt,
      signature,
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
        operation: input.operation,
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
      await recordLifecycleFailure({
        env: input.env,
        attempt,
        operation: input.operation,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        error,
        failedAt,
        resetClaim: true,
      });
    } catch (resetError) {
      getLogger().error(
        {
          error: resetError instanceof Error ? resetError.message : String(resetError),
          operation: input.operation,
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
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  /** Money admission (HOO-1955), run only if the resume still has to sign. */
  admitStart: () => Promise<void>;
  /** The request's Idempotency-Key, written on the attempt; null for the cron. */
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  return runRecurringPaymentLifecycle({ ...input, operation: "resume" });
}
