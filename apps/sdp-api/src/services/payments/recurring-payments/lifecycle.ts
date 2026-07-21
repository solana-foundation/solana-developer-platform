import {
  decideRecurringPaymentLifecycleTransition,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  type RecurringPaymentLifecycleOperation,
} from "@sdp/payments/recurring-payment-lifecycle";
import { assertValidAddress } from "@sdp/solana/address";
import type { Address, Signature } from "@solana/kit";
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
import { AppError, badRequest } from "@/lib/errors";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { recoverOrBlockLifecycleCollection } from "./collection";
import { confirmSubscriptionSignature, sendSubscriptionInstructions } from "./shared";

function lifecycleConfirmationMessage(operation: RecurringPaymentLifecycleOperation) {
  return operation === "cancel"
    ? "Recurring payment cancellation failed on-chain"
    : "Recurring payment resume failed on-chain";
}

function lifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLifecyclePreconditions(input: {
  operation: RecurringPaymentLifecycleOperation;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  nowIso: string;
}): void {
  if (input.recurringPayment.source_wallet_id !== input.sourceWallet.walletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }
  if (input.recurringPayment.source_address !== input.sourceWallet.publicKey) {
    throw badRequest("Recurring payment source address does not match wallet");
  }

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
    throw new AppError("CONFLICT", `Recurring payment ${input.operation} is already processing`);
  }
  throw new AppError(
    "CONFLICT",
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
    statuses: ["processing"],
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
    throw new AppError("INTERNAL_ERROR", "Failed to journal recurring payment lifecycle");
  }

  return attempt;
}

async function recordLifecycleFailure(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  operation: RecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  error: unknown;
  failedAt: string;
  resetClaim: boolean;
}): Promise<void> {
  await input.recurringRepo.updateLifecycleAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "failed",
    stage: input.stage,
    error: lifecycleErrorMessage(input.error),
    updatedAt: input.failedAt,
  });

  if (input.resetClaim) {
    const { claimableStatus, processingStatus } = getRecurringPaymentLifecycleStatuses(
      input.operation
    );
    await input.recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.attempt.recurring_payment_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: claimableStatus,
      expectedStatus: processingStatus,
      updatedAt: input.failedAt,
    });
  }
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
  error: unknown;
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
      error: lifecycleErrorMessage(input.error),
      updatedAt: input.failedAt,
    });
  } catch (journalError) {
    console.error("Failed to preserve recoverable recurring payment lifecycle attempt", {
      error: lifecycleErrorMessage(journalError),
      operation: input.operation,
      recurringPaymentId: input.recurringPaymentId,
    });
  }

  console.error("Recurring payment lifecycle left recoverable after submission", {
    confirmedOnChain: input.confirmedOnChain,
    error: lifecycleErrorMessage(input.error),
    operation: input.operation,
    recurringPaymentId: input.recurringPaymentId,
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
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment lifecycle");
    }

    return updatedRecurringPayment;
  });
}

async function runRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  operation: RecurringPaymentLifecycleOperation;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const paymentsRepo = createPaymentsRepository(input.env);
  const nowIso = new Date().toISOString();

  assertLifecyclePreconditions({ ...input, nowIso });
  if (
    input.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).finalStatus
  ) {
    return input.recurringPayment;
  }

  const settled = await recoverOrBlockLifecycleCollection({
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
    recurringPayment: settled.recurringPayment,
    sourceWallet: input.sourceWallet,
    nowIso: new Date().toISOString(),
  });
  if (
    settled.recurringPayment.status ===
    getRecurringPaymentLifecycleStatuses(input.operation).finalStatus
  ) {
    return settled.recurringPayment;
  }

  const claimed = await recurringRepo.claimRecurringPaymentLifecycle({
    recurringPaymentId: settled.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    operation: input.operation,
    updatedAt: new Date().toISOString(),
    staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
  });

  if (!claimed) {
    throw new AppError("CONFLICT", `Recurring payment ${input.operation} is already processing`);
  }

  let attempt = await getOrCreateLifecycleAttempt({
    recurringRepo,
    claimed,
    operation: input.operation,
    organizationId: input.organizationId,
    projectId: input.projectId,
    nowIso,
  });

  let currentStage: PaymentRecurringPaymentLifecycleAttemptStage = attempt.stage;
  let signature = attempt.signature as Signature | null;
  let confirmedOnChain = false;

  try {
    if (!claimed.plan_pda || !claimed.subscription_id || !claimed.subscription_pda) {
      throw new AppError("CONFLICT", "Recurring payment is missing on-chain subscription records");
    }

    const subscription =
      settled.subscription?.id === claimed.subscription_id
        ? settled.subscription
        : await subscriptionsRepo.getSubscriptionById({
            subscriptionId: claimed.subscription_id,
            organizationId: input.organizationId,
            projectId: input.projectId,
          });
    if (!subscription) {
      throw new AppError("NOT_FOUND", "Subscription not found");
    }

    const expectedSubscriptionStatus = input.operation === "cancel" ? "active" : "canceled";
    const finalSubscriptionStatus = input.operation === "cancel" ? "canceled" : "active";
    if (
      subscription.status !== expectedSubscriptionStatus &&
      subscription.status !== finalSubscriptionStatus
    ) {
      throw new AppError(
        "CONFLICT",
        `Subscription cannot be ${input.operation === "cancel" ? "canceled" : "resumed"} from this status`
      );
    }

    const sourceSigner = await solanaServices.createOrgSigner(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.walletId
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    const planPda = assertValidAddress(claimed.plan_pda, "planPda") as Address;
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

      const instruction =
        input.operation === "cancel"
          ? await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
              planPda,
              subscriber: sourceSigner,
              subscriptionPda,
            })
          : await subscriptionsProgram.getResumeSubscriptionOverlayInstructionAsync({
              planPda,
              subscriber: sourceSigner,
              subscriptionPda,
            });

      signature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
      });

      attempt =
        (await recurringRepo.updateLifecycleAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          stage: currentStage,
          signature,
          error: null,
          updatedAt: new Date().toISOString(),
        })) ?? attempt;
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
        recurringRepo,
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
      console.error("Failed to journal/reset recurring payment lifecycle after failure", {
        error: resetError instanceof Error ? resetError.message : String(resetError),
        operation: input.operation,
        recurringPaymentId: claimed.id,
      });
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
