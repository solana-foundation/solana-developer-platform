import {
  decideRecurringPaymentLifecycleTransition,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  type RecurringPaymentLifecycleOperation,
} from "@sdp/payments/recurring-payment-lifecycle";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isPendingActivationRecurringPaymentStatus,
} from "@sdp/types";
import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  type PaymentRecurringPaymentLifecycleAttemptRow,
  type PaymentRecurringPaymentLifecycleAttemptStage,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  type PaymentSubscriptionRow,
  type PaymentSubscriptionsRepository,
} from "@/db/repositories";
import { AppError, badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import {
  assertRecurringPaymentSourceWallet,
  assertRecurringPaymentTokenMint,
  confirmSubscriptionSignature,
  parseNullableStoredSignature,
  recurringPaymentErrorMessage,
  sendSubscriptionInstructions,
} from "./shared";

function lifecycleConfirmationMessage(operation: RecurringPaymentLifecycleOperation) {
  return operation === "cancel"
    ? "Recurring payment cancellation failed on-chain"
    : "Recurring payment resume failed on-chain";
}

async function buildLifecycleInstruction(input: {
  env: Env;
  operation: RecurringPaymentLifecycleOperation;
  planPda: Address;
  subscriber: TransactionSigner;
  subscriptionPda: Address;
  tokenMint: Address;
}): Promise<Instruction> {
  if (input.operation === "cancel") {
    return subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
      planPda: input.planPda,
      subscriber: input.subscriber,
      subscriptionPda: input.subscriptionPda,
    });
  }

  const onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
    solanaRpc.createRpc(input.env),
    input.subscriptionPda,
    { commitment: "confirmed" }
  );
  if (!onChainSubscription.exists) {
    throw conflict("Subscription was not found on-chain");
  }

  return subscriptionsProgram.getResumeSubscriptionOverlayInstructionAsync({
    expectedExpiresAtTs: onChainSubscription.data.expiresAtTs,
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

/**
 * A cancel claim whose subscription is still pending_authorization can only
 * originate from a pending_activation cancellation (SOLA9-454): the ordinary
 * active-cancel flow runs against an active subscription. Resetting such a
 * claim to active would strand the payment outside the reconciling
 * pending-activation cancel path, so restore its recoverable origin instead.
 */
async function resolveRecurringPaymentCancelClaimableStatus(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
}): Promise<PaymentRecurringPaymentRow["status"]> {
  const { claimableStatus } = getRecurringPaymentLifecycleStatuses("cancel");
  if (!input.claimed.subscription_id) {
    return claimableStatus;
  }
  const subscription = await input.subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.claimed.subscription_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  return subscription?.status === "pending_authorization" ? "pending_activation" : claimableStatus;
}

async function getOrCreateLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<PaymentRecurringPaymentLifecycleAttemptRow> {
  const existing = await input.recurringRepo.getLatestLifecycleAttempt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    operation: input.operation,
    statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  });

  if (existing) {
    return existing;
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
    });
  } catch (error) {
    await resetRecurringPaymentLifecycleClaim({
      recurringRepo: input.recurringRepo,
      subscriptionsRepo: input.subscriptionsRepo,
      claimed: input.claimed,
      operation: input.operation,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }

  if (!attempt) {
    await resetRecurringPaymentLifecycleClaim({
      recurringRepo: input.recurringRepo,
      subscriptionsRepo: input.subscriptionsRepo,
      claimed: input.claimed,
      operation: input.operation,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: new Date().toISOString(),
    });
    throw internalError("Failed to journal recurring payment lifecycle");
  }

  return attempt;
}

async function resetRecurringPaymentLifecycleClaim(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  updatedAt: string;
}): Promise<void> {
  const { processingStatus } = getRecurringPaymentLifecycleStatuses(input.operation);
  const claimableStatus =
    input.operation === "cancel"
      ? await resolveRecurringPaymentCancelClaimableStatus({
          subscriptionsRepo: input.subscriptionsRepo,
          claimed: input.claimed,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : getRecurringPaymentLifecycleStatuses(input.operation).claimableStatus;
  const reset = await input.recurringRepo.updateRecurringPaymentLifecycle({
    recurringPaymentId: input.claimed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: claimableStatus,
    expectedStatus: processingStatus,
    updatedAt: input.updatedAt,
  });
  if (!reset) {
    throw conflict("Recurring payment lifecycle changed concurrently");
  }
}

async function recordLifecycleFailure(input: {
  env: Env;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  claimed: PaymentRecurringPaymentRow;
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
      await resetRecurringPaymentLifecycleClaim({
        recurringRepo,
        subscriptionsRepo: createPostgresPaymentSubscriptionsRepository(tx),
        claimed: input.claimed,
        operation: input.operation,
        organizationId: input.organizationId,
        projectId: input.projectId,
        updatedAt: input.failedAt,
      });
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
  signature: Signature;
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
  signature: Signature;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Lifecycle recovery keeps each persisted stage explicit.
async function runRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
}): Promise<PaymentRecurringPaymentRow> {
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
    return input.recurringPayment;
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
    return collectionState.recurringPayment;
  }

  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );

  const claimResult = await getDb(input.env).transaction(async (tx) => {
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentLifecycle({
      recurringPaymentId: collectionState.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: input.operation,
      updatedAt: new Date().toISOString(),
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
    });
    if (!claimed) return null;
    const attempt = await getOrCreateLifecycleAttempt({
      recurringRepo: transactionRepo,
      subscriptionsRepo: createPostgresPaymentSubscriptionsRepository(tx),
      claimed,
      operation: input.operation,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
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
    const tokenMint = assertValidAddress(
      await assertRecurringPaymentTokenMint(
        plan.token,
        input.organizationId,
        input.projectId,
        input.env
      ),
      "tokenMint"
    );

    // A cancel claim may originate from pending_activation when the activation
    // broadcast already landed (SOLA9-454): the subscription row is still
    // pending_authorization until the revoking cancel finalizes it.
    const expectedSubscriptionStatuses: Array<PaymentSubscriptionRow["status"]> =
      input.operation === "cancel" ? ["active", "pending_authorization"] : ["canceled"];
    const finalSubscriptionStatus = input.operation === "cancel" ? "canceled" : "active";
    if (
      !expectedSubscriptionStatuses.includes(subscription.status) &&
      subscription.status !== finalSubscriptionStatus
    ) {
      throw conflict(
        `Subscription cannot be ${input.operation === "cancel" ? "canceled" : "resumed"} from this status`
      );
    }

    const sourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    const planPda = assertValidAddress(claimed.plan_pda, "planPda");
    const subscriptionPda = assertValidAddress(claimed.subscription_pda, "subscriptionPda");

    if (!signature) {
      currentStage = "submit";
      await recurringRepo.updateLifecycleAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        updatedAt: new Date().toISOString(),
      });

      const instruction = await buildLifecycleInstruction({
        env: input.env,
        operation: input.operation,
        planPda,
        subscriber: sourceSigner,
        subscriptionPda,
        tokenMint,
      });

      signature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
      });

      const updatedAttempt = await recurringRepo.updateLifecycleAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        signature,
        error: null,
        updatedAt: new Date().toISOString(),
      });
      if (updatedAttempt === null) {
        throw conflict("Recurring payment lifecycle attempt changed concurrently");
      }
      attempt = updatedAttempt;
    }

    await confirmSubscriptionSignature(
      input.env,
      signature,
      lifecycleConfirmationMessage(input.operation)
    );
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
    const transactionFailed = error instanceof AppError && error.code === "TRANSACTION_FAILED";

    if (signature && !transactionFailed) {
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
        claimed,
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

/**
 * Activation persists the subscription records (including the delegation PDA)
 * before the Subscribe broadcast, so their presence means the on-chain
 * delegation may be live even though the row fell back to pending_activation
 * after a journal failure (SOLA9-454).
 */
function hasRecurringPaymentPersistedSubscriptionRecords(
  recurringPayment: PaymentRecurringPaymentRow
): boolean {
  return recurringPayment.subscription_id !== null || recurringPayment.subscription_pda !== null;
}

/**
 * A pending_activation cancel retry can finalize locally while an earlier
 * uncertain cancellation attempt is still journalled as processing (its
 * submitted cancellation landed and revoked the delegation). Recovery no
 * longer selects a canceled payment, so close the attempt in the same
 * transaction to keep the lifecycle journal coherent.
 */
async function closeInFlightCancelLifecycleAttempt(
  recurringRepo: PaymentRecurringPaymentsRepository,
  input: {
    organizationId: string;
    projectId: string;
    recurringPaymentId: string;
    finalizedAt: string;
  }
): Promise<void> {
  const attempt = await recurringRepo.getLatestLifecycleAttempt({
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    operation: "cancel",
    statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  });
  if (!attempt) {
    return;
  }
  const closedAttempt = await recurringRepo.updateLifecycleAttempt({
    attemptId: attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "confirmed",
    stage: "finalize",
    signature: attempt.signature,
    error: null,
    updatedAt: input.finalizedAt,
  });
  if (!closedAttempt) {
    throw conflict("Recurring payment lifecycle attempt changed concurrently");
  }
}

async function finalizePendingActivationCancellationLocally(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const updated = await txRecurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "canceled",
      expectedStatus: "pending_activation",
      updatedAt: finalizedAt,
    });
    if (!updated) {
      // Check inside the transaction so a lost race rolls the subscription
      // update back instead of committing inconsistent records.
      throw conflict("Recurring payment status changed before it could be canceled");
    }
    await closeInFlightCancelLifecycleAttempt(txRecurringRepo, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      finalizedAt,
    });
    if (input.subscription) {
      await txSubscriptionsRepo.updateSubscription({
        subscriptionId: input.subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "canceled",
        cancelAt: finalizedAt,
        canceledAt: finalizedAt,
        updatedAt: finalizedAt,
      });
    }
    return updated;
  });
}

/**
 * Cancels a pending_activation recurring payment whose activation already
 * persisted subscription records. The on-chain delegation is reconciled
 * first: a live delegation is revoked with a confirmed cancel instruction
 * before the SDP rows are marked canceled, and unknown chain state keeps the
 * record in its recoverable pending_activation state.
 */
async function cancelReconcilablePendingActivationRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );

  const subscription = await subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.recurringPayment.subscription_id ?? "",
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!subscription) {
    throw notFound("Subscription");
  }
  const subscriptionPdaValue =
    subscription.subscription_pda ?? input.recurringPayment.subscription_pda;
  if (!subscriptionPdaValue) {
    // Activation never reached delegation setup: nothing can be live on chain.
    return finalizePendingActivationCancellationLocally({ ...input, subscription });
  }

  const subscriptionPda = assertValidAddress(subscriptionPdaValue, "subscriptionPda");
  const rpc = solanaRpc.createRpc(input.env);
  let onChainDelegation: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  >;
  try {
    onChainDelegation = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
      rpc,
      subscriptionPda,
      { commitment: "confirmed" }
    );
  } catch (error) {
    getLogger().error(
      {
        error: error instanceof Error ? error.message : String(error),
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: input.recurringPayment.id,
        subscription_pda: subscriptionPda,
      },
      "Failed to reconcile on-chain subscription delegation before pending_activation cancellation"
    );
    // Chain state is unknown: keep the record recoverable instead of
    // reporting a cancellation that may leave the delegation live.
    throw error;
  }

  if (!onChainDelegation.exists) {
    // Activation broadcasts Subscribe before confirming it and can reset the
    // row to pending_activation with the authorization signature retained
    // (SOLA9-454). A submitted authorization that has not landed yet leaves no
    // delegation for the read above, so resolve it before finalizing locally:
    // finalizing first would report a cancellation that a later-landing
    // authorization could survive with a live delegation.
    const authorizationSignature = parseNullableStoredSignature(
      input.recurringPayment.authorization_signature ?? subscription.authorization_signature
    );
    if (authorizationSignature) {
      try {
        await confirmSubscriptionSignature(
          input.env,
          authorizationSignature,
          "Recurring payment authorization failed on-chain"
        );
      } catch (error) {
        if (error instanceof AppError && error.code === "TRANSACTION_FAILED") {
          // The authorization failed on-chain and can never create a
          // delegation, so finalizing locally cannot leave one live.
          return finalizePendingActivationCancellationLocally({ ...input, subscription });
        }
        // Chain state is unknown: keep the record recoverable instead of
        // reporting a cancellation that may leave the delegation live.
        throw error;
      }
      // The authorization landed: re-read the delegation in case an earlier
      // submitted cancellation already revoked it.
      const landedDelegation = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
        rpc,
        subscriptionPda,
        { commitment: "confirmed" }
      );
      if (landedDelegation.exists) {
        return revokeLivePendingActivationDelegation({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          sourceWallet: input.sourceWallet,
          recurringPayment: input.recurringPayment,
          recurringRepo,
          subscriptionsRepo,
          subscription,
          subscriptionPda,
        });
      }
    }
    return finalizePendingActivationCancellationLocally({ ...input, subscription });
  }

  return revokeLivePendingActivationDelegation({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    recurringPayment: input.recurringPayment,
    recurringRepo,
    subscriptionsRepo,
    subscription,
    subscriptionPda,
  });
}

async function revokeLivePendingActivationDelegation(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  subscription: PaymentSubscriptionRow;
  subscriptionPda: Address;
}): Promise<PaymentRecurringPaymentRow> {
  const nowIso = new Date().toISOString();

  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );

  const claimed = await input.recurringRepo.updateRecurringPaymentLifecycle({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "canceling",
    expectedStatus: "pending_activation",
    updatedAt: nowIso,
  });
  if (!claimed) {
    throw conflict("Recurring payment status changed before it could be canceled");
  }

  // Reuse an in-flight attempt from an earlier uncertain submission so a retry
  // confirms the already-journalled signature instead of broadcasting a
  // duplicate cancellation.
  const attempt = await getOrCreateLifecycleAttempt({
    recurringRepo: input.recurringRepo,
    subscriptionsRepo: input.subscriptionsRepo,
    claimed,
    operation: "cancel",
    organizationId: input.organizationId,
    projectId: input.projectId,
    nowIso,
  });

  let currentStage: PaymentRecurringPaymentLifecycleAttemptStage = attempt.stage;
  let signature = parseNullableStoredSignature(attempt.signature);
  let confirmedOnChain = false;
  try {
    if (!claimed.plan_pda) {
      throw conflict("Recurring payment is missing on-chain subscription records");
    }
    const planPda = assertValidAddress(claimed.plan_pda, "planPda");
    const sourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    if (!signature) {
      currentStage = "submit";
      await input.recurringRepo.updateLifecycleAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        updatedAt: new Date().toISOString(),
      });

      const instruction = await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
        planPda,
        subscriber: sourceSigner,
        subscriptionPda: input.subscriptionPda,
      });
      signature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
      });
      await input.recurringRepo.updateLifecycleAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        signature,
        error: null,
        updatedAt: new Date().toISOString(),
      });
    }

    await confirmSubscriptionSignature(
      input.env,
      signature,
      "Recurring payment cancellation failed on-chain"
    );
    confirmedOnChain = true;

    return await finalizeRecurringPaymentLifecycle({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      operation: "cancel",
      recurringPayment: claimed,
      subscription: input.subscription,
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
      "Recurring payment pending_activation cancellation reconciliation failed"
    );
    const failedAt = new Date().toISOString();
    const transactionFailed = error instanceof AppError && error.code === "TRANSACTION_FAILED";

    if (signature && !transactionFailed) {
      // A cancellation was already submitted and its outcome is uncertain:
      // keep the attempt and its signature recoverable like the ordinary
      // lifecycle path instead of marking the attempt failed, so a retry
      // confirms the submitted cancellation rather than broadcasting a
      // duplicate. The claim returns to its recoverable pending_activation
      // state, which re-enters this reconciling path on retry.
      await preserveRecoverableLifecycleAttempt({
        recurringRepo: input.recurringRepo,
        attempt,
        operation: "cancel",
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: claimed.id,
        stage: currentStage,
        signature,
        error,
        failedAt,
        confirmedOnChain,
      });
      try {
        await resetRecurringPaymentClaim(input.recurringRepo, claimed, failedAt);
      } catch (resetError) {
        getLogger().error(
          {
            error: resetError instanceof Error ? resetError.message : String(resetError),
            operation: "cancel",
            recurring_payment_id: claimed.id,
          },
          "Failed to reset recurring payment claim after uncertain pending_activation cancellation"
        );
      }
      throw error;
    }

    try {
      await getDb(input.env).transaction(async (tx) => {
        const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
        await txRecurringRepo.updateLifecycleAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          status: "failed",
          stage: currentStage,
          signature,
          error: recurringPaymentErrorMessage(error),
          updatedAt: new Date().toISOString(),
        });
        await resetRecurringPaymentClaim(txRecurringRepo, claimed, new Date().toISOString());
      });
    } catch (resetError) {
      getLogger().error(
        {
          error: resetError instanceof Error ? resetError.message : String(resetError),
          operation: "cancel",
          recurring_payment_id: claimed.id,
        },
        "Failed to journal/reset recurring payment after failed pending_activation cancellation"
      );
    }
    throw error;
  }
}

async function resetRecurringPaymentClaim(
  recurringRepo: PaymentRecurringPaymentsRepository,
  claimed: PaymentRecurringPaymentRow,
  updatedAt: string
): Promise<void> {
  const reset = await recurringRepo.updateRecurringPaymentLifecycle({
    recurringPaymentId: claimed.id,
    organizationId: claimed.organization_id,
    projectId: claimed.project_id,
    status: "pending_activation",
    expectedStatus: "canceling",
    updatedAt,
  });
  if (!reset) {
    throw conflict("Recurring payment lifecycle changed concurrently");
  }
}

export async function cancelRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<PaymentRecurringPaymentRow> {
  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
    if (!hasRecurringPaymentPersistedSubscriptionRecords(input.recurringPayment)) {
      const recurringRepo = createPaymentRecurringPaymentsRepository(
        input.env,
        createTenantScope(input)
      );
      const updated = await recurringRepo.updateRecurringPaymentLifecycle({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "canceled",
        expectedStatus: "pending_activation",
        updatedAt: new Date().toISOString(),
      });
      if (!updated) {
        throw conflict("Recurring payment status changed before it could be canceled");
      }
      return updated;
    }
    return cancelReconcilablePendingActivationRecurringPayment(input);
  }
  return runRecurringPaymentLifecycle({ ...input, operation: "cancel" });
}

export async function resumeRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<PaymentRecurringPaymentRow> {
  return runRecurringPaymentLifecycle({ ...input, operation: "resume" });
}
