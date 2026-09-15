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

async function getOrCreateLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  nowIso: string;
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
}): Promise<PaymentRecurringPaymentRow> {
  if (isPendingActivationRecurringPaymentStatus(input.recurringPayment.status)) {
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
