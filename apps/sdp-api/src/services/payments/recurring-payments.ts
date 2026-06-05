import { getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  createPostgresPaymentsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import type {
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import type {
  PaymentsRepository,
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { parsePositiveIntegerConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createSigningService } from "@/services/domain/signing.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";
import {
  assertSubscriptionTokenMint,
  collectSubscriptionOnChain,
  deriveAssociatedTokenAccount,
  ensureSubscriptionAuthorizationOnChain,
  ensureSubscriptionPlanOnChain,
  executeSubscriptionLifecycleOnChain,
  generateProgramPlanId,
  resolveRecurringSubscriptionRuntime,
} from "./solana-subscriptions-adapter";

export type ActivationResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  planSignature?: string;
  authorizationSignature?: string;
};

export type CollectionResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
};

function addPeriodHours(timestamp: string, periodHours: number): string {
  return new Date(new Date(timestamp).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

function advanceCollectionDueAtAfter(input: {
  nextCollectionDueAt: string | null;
  periodHours: number;
  after: string;
}): string {
  const periodMs = input.periodHours * 60 * 60 * 1000;
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new AppError("BAD_REQUEST", "Recurring payment period must be greater than zero");
  }

  const afterMs = new Date(input.after).getTime();
  const dueMs = input.nextCollectionDueAt ? new Date(input.nextCollectionDueAt).getTime() : NaN;

  if (input.nextCollectionDueAt && Number.isFinite(dueMs) && dueMs > afterMs) {
    return input.nextCollectionDueAt;
  }

  if (Number.isFinite(dueMs)) {
    const elapsedPeriods = Math.floor((afterMs - dueMs) / periodMs) + 1;
    return new Date(dueMs + elapsedPeriods * periodMs).toISOString();
  }

  return new Date(afterMs + periodMs).toISOString();
}

const ACTIVATION_CLAIM_TTL_MS = 10 * 60 * 1000;
const ACTIVE_COLLECTION_ATTEMPT_STATUSES = new Set(["pending", "processing", "confirmed"]);
const DEFAULT_COLLECTION_RETRY_AFTER_MINUTES = 30;

function getCollectionRetryAfter(env: Env, now = new Date()): string {
  const retryAfterMinutes = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_COLLECTION_RETRY_AFTER_MINUTES
  );

  return new Date(now.getTime() - retryAfterMinutes * 60 * 1000).toISOString();
}

function isFreshActivationClaim(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < ACTIVATION_CLAIM_TTL_MS;
}

function isActiveCollectionAttempt(attempt: PaymentSubscriptionCollectionAttemptRow): boolean {
  return ACTIVE_COLLECTION_ATTEMPT_STATUSES.has(attempt.status);
}

function isStaleUnsignedProcessingAttempt(
  attempt: PaymentSubscriptionCollectionAttemptRow,
  retryAfter: string
): boolean {
  return (
    attempt.status === "processing" &&
    !attempt.signature &&
    new Date(attempt.updated_at).getTime() <= new Date(retryAfter).getTime()
  );
}

async function getSourceSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  expectedAddress: string;
}) {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWalletId
  );

  if (signer.address !== input.expectedAddress) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  return signer;
}

async function resolveSourceWalletForExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
}): Promise<CustodyWallet> {
  const signingService = createSigningService(input.env);
  const wallets = await signingService.getWalletsWithProviders(
    input.organizationId,
    input.projectId,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((entry) => entry.walletId === input.sourceWalletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
  }

  return wallet;
}

async function createTransferRecord(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  status: PaymentTransferStatus;
  initiatedByKeyId?: string | null;
  paymentsRepo?: PaymentsRepository;
  createdAt?: string;
}) {
  const now = input.createdAt ?? new Date().toISOString();
  const paymentsRepo = input.paymentsRepo ?? createPaymentsRepository(input.env);
  const transfer = await paymentsRepo.createTransfer({
    id: `xfr_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.recurringPayment.source_wallet_id,
    sourceAddress: input.recurringPayment.source_address,
    destinationAddress: input.recurringPayment.destination_address,
    token: input.recurringPayment.token,
    amount: input.recurringPayment.amount,
    memo: null,
    type: "transfer",
    direction: "outbound",
    status: input.status,
    serializedTx: null,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  return transfer;
}

async function claimActivationRecords(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  destinationTokenAccount: string;
  subscriberTokenAccount: string;
}): Promise<
  | {
      alreadyActive: true;
      recurringPayment: PaymentRecurringPaymentRow;
      plan?: never;
      subscription?: never;
    }
  | {
      alreadyActive: false;
      recurringPayment: PaymentRecurringPaymentRow;
      plan: PaymentSubscriptionPlanRow;
      subscription: PaymentSubscriptionRow;
    }
> {
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPaymentId, input.organizationId, input.projectId)
      .first();

    const recurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    if (!recurringPayment) {
      throw new AppError("NOT_FOUND", "Recurring payment not found");
    }
    if (recurringPayment.status === "active") {
      return { alreadyActive: true, recurringPayment };
    }
    if (
      recurringPayment.status === "activating" &&
      isFreshActivationClaim(recurringPayment.updated_at)
    ) {
      throw new AppError("CONFLICT", "Recurring payment activation is already in progress");
    }
    if (
      recurringPayment.status !== "pending_activation" &&
      recurringPayment.status !== "activating"
    ) {
      throw new AppError(
        "BAD_REQUEST",
        "Recurring payment cannot be activated from its current status"
      );
    }

    const now = new Date().toISOString();
    let plan = recurringPayment.plan_id
      ? await txSubscriptionsRepo.getPlanById({
          planId: recurringPayment.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!plan) {
      plan = await txSubscriptionsRepo.createPlan({
        id: `psp_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerWalletId: recurringPayment.source_wallet_id,
        ownerAddress: recurringPayment.source_address,
        token: recurringPayment.token,
        amount: recurringPayment.amount,
        periodHours: recurringPayment.period_hours,
        programPlanId: generateProgramPlanId(),
        planPda: null,
        destinationAddress: input.destinationTokenAccount,
        pullerWalletId: recurringPayment.source_wallet_id,
        pullerAddress: recurringPayment.source_address,
        metadataUri: recurringPayment.metadata_uri,
        status: "draft",
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!plan) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
    }

    let subscription = recurringPayment.subscription_id
      ? await txSubscriptionsRepo.getSubscriptionById({
          subscriptionId: recurringPayment.subscription_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!subscription) {
      subscription = await txSubscriptionsRepo.createSubscription({
        id: `psub_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planId: plan.id,
        counterpartyId: recurringPayment.counterparty_id,
        subscriberAddress: recurringPayment.source_address,
        subscriberTokenAccount: input.subscriberTokenAccount,
        subscriptionPda: null,
        subscriptionAuthorityAddress: null,
        authorizationSignature: null,
        status: "pending_authorization",
        currentPeriodStartAt: null,
        nextCollectionDueAt: null,
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!subscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
    }

    const claimedPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount: input.destinationTokenAccount,
      planId: plan.id,
      subscriptionId: subscription.id,
      status: "activating",
      updatedAt: now,
    });

    if (!claimedPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to claim recurring payment activation");
    }

    return {
      alreadyActive: false,
      recurringPayment: claimedPayment,
      plan,
      subscription,
    };
  });
}

async function updateTransferRecord(input: {
  env: Env;
  transferId: string;
  status?: PaymentTransferStatus;
  signature?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  error?: string | null;
}) {
  const updated = await createPaymentsRepository(input.env).updateTransfer({
    transferId: input.transferId,
    status: input.status,
    signature: input.signature,
    slot: input.slot,
    blockTime: input.blockTime,
    error: input.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return updated;
}

function getStringMetadataValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumberMetadataValue(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function markRecurringCollectionSubmitted(input: {
  env: Env;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: string;
  slot: number | null;
  blockTime: string | null;
  destinationTokenAccount: string;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  hasRecoveryMarker: boolean;
  hasAttemptRecoveryMarker: boolean;
}> {
  const updatedAt = new Date().toISOString();
  const metadata = {
    ...input.attempt.metadata,
    source: "recurring_payments",
    destinationTokenAccount: input.destinationTokenAccount,
    collectionSignature: input.signature,
    collectionSlot: input.slot,
    collectionBlockTime: input.blockTime,
  };

  const [transferResult, attemptResult] = await Promise.allSettled([
    updateTransferRecord({
      env: input.env,
      transferId: input.transfer.id,
      status: "processing",
      signature: input.signature,
      slot: input.slot,
      blockTime: input.blockTime,
      error: null,
    }),
    createPaymentSubscriptionsRepository(input.env).updateCollectionAttempt({
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      status: "processing",
      signature: input.signature,
      error: null,
      metadata,
      attemptedAt: updatedAt,
      updatedAt,
    }),
  ]);

  if (transferResult.status === "rejected") {
    console.error("Failed to persist recurring collection transfer recovery marker", {
      transferId: input.transfer.id,
      error:
        transferResult.reason instanceof Error
          ? transferResult.reason.message
          : String(transferResult.reason),
    });
  }
  if (attemptResult.status === "rejected") {
    console.error("Failed to persist recurring collection attempt recovery marker", {
      attemptId: input.attempt.id,
      error:
        attemptResult.reason instanceof Error
          ? attemptResult.reason.message
          : String(attemptResult.reason),
    });
  }

  const updatedTransfer =
    transferResult.status === "fulfilled" ? transferResult.value : input.transfer;
  const updatedAttempt =
    attemptResult.status === "fulfilled" && attemptResult.value
      ? attemptResult.value
      : input.attempt;
  const transferHasSubmissionMarker =
    transferResult.status === "fulfilled" && Boolean(transferResult.value?.signature);
  const attemptHasSubmissionMarker =
    attemptResult.status === "fulfilled" && Boolean(attemptResult.value?.signature);

  if (!transferHasSubmissionMarker && !attemptHasSubmissionMarker) {
    console.error("Recurring collection submitted on-chain without a persisted recovery marker", {
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      signature: input.signature,
    });
  }

  return {
    attempt: updatedAttempt,
    transfer: updatedTransfer,
    hasRecoveryMarker: transferHasSubmissionMarker || attemptHasSubmissionMarker,
    hasAttemptRecoveryMarker: attemptHasSubmissionMarker,
  };
}

async function finalizeRecurringCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  dueAt: string;
  signature: string;
  slot: number | null;
  blockTime: string | null;
  destinationTokenAccount: string;
}): Promise<CollectionResult> {
  const nextDueAt = addPeriodHours(input.dueAt, input.recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    const txPaymentsRepo = createPostgresPaymentsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const lockedRecurringPayment = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_recurring_payments
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.recurringPayment.id, input.organizationId, input.projectId]
    );
    const lockedSubscription = await tx.queryOne<{
      status: string;
      next_collection_due_at: string | null;
    }>(
      `SELECT status, next_collection_due_at
         FROM payment_subscriptions
        WHERE id = ?
          AND organization_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [input.subscriptionId, input.organizationId, input.projectId]
    );

    if (!lockedRecurringPayment || !lockedSubscription) {
      throw new AppError("NOT_FOUND", "Recurring payment collection state not found");
    }
    if (
      lockedRecurringPayment.status !== "active" ||
      lockedRecurringPayment.next_collection_due_at !== input.dueAt ||
      lockedSubscription.status !== "active" ||
      lockedSubscription.next_collection_due_at !== input.dueAt
    ) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment collection state changed before finalization started"
      );
    }

    const transferStatus = input.transfer.status === "finalized" ? "finalized" : "confirmed";
    const updatedTransfer = await txPaymentsRepo.updateTransfer({
      transferId: input.transfer.id,
      status: transferStatus,
      signature: input.signature,
      slot: input.slot,
      blockTime: input.blockTime,
      error: null,
      updatedAt,
    });
    const updatedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
      attemptId: input.attempt.id,
      transferId: input.transfer.id,
      status: "confirmed",
      signature: input.signature,
      attemptedAt: updatedAt,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "active",
      expectedNextCollectionDueAt: input.dueAt,
      destinationTokenAccount: input.destinationTokenAccount,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "active",
      expectedNextCollectionDueAt: input.dueAt,
      currentPeriodStartAt: input.dueAt,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });

    if (!updatedTransfer || !updatedAttempt) {
      throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment collection state");
    }
    if (!updatedRecurringPayment || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment collection state changed before finalization completed"
      );
    }

    return {
      recurringPayment: updatedRecurringPayment,
      collectionAttempt: updatedAttempt,
      transfer: updatedTransfer,
    };
  });
}

async function recoverSubmittedRecurringCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
}): Promise<CollectionResult | null> {
  if (!input.attempt.transfer_id) {
    return null;
  }

  const transfer = await createPaymentsRepository(input.env).getTransferById({
    transferId: input.attempt.transfer_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!transfer) {
    return null;
  }

  const signature = input.attempt.signature ?? transfer.signature;
  if (!signature) {
    return null;
  }

  const destinationTokenAccount =
    getStringMetadataValue(input.attempt.metadata, "destinationTokenAccount") ??
    input.recurringPayment.destination_token_account;
  if (!destinationTokenAccount) {
    return null;
  }

  return finalizeRecurringCollection({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    attempt: input.attempt,
    transfer,
    dueAt: input.dueAt,
    signature,
    slot: transfer.slot ?? getNumberMetadataValue(input.attempt.metadata, "collectionSlot"),
    blockTime:
      transfer.block_time ?? getStringMetadataValue(input.attempt.metadata, "collectionBlockTime"),
    destinationTokenAccount,
  });
}

async function createFailedCollectionAttemptForRetry(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  error: string;
  initiatedByKeyId?: string | null;
}) {
  const now = new Date().toISOString();
  try {
    await createPaymentSubscriptionsRepository(input.env).createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: input.subscriptionId,
      recurringPaymentId: input.recurringPayment.id,
      transferId: null,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      dueAt: input.dueAt,
      attemptedAt: now,
      status: "failed",
      signature: null,
      error: input.error,
      metadata: {
        source: "recurring_payments",
        initiatedByKeyId: input.initiatedByKeyId ?? null,
      },
      createdAt: now,
      updatedAt: now,
    });
  } catch (recordError) {
    console.warn("Failed to record recurring collection retry backoff attempt", {
      recurringPaymentId: input.recurringPayment.id,
      dueAt: input.dueAt,
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}

async function resolveStaleUnsignedProcessingAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  retryAfter: string;
}): Promise<boolean> {
  if (!isStaleUnsignedProcessingAttempt(input.attempt, input.retryAfter)) {
    return false;
  }

  const now = new Date().toISOString();
  if (!input.attempt.transfer_id) {
    const failedAttempt = await createPaymentSubscriptionsRepository(
      input.env
    ).updateCollectionAttempt({
      attemptId: input.attempt.id,
      status: "failed",
      error: "Stale recurring collection attempt expired before transfer submission",
      attemptedAt: now,
      updatedAt: now,
    });

    if (!failedAttempt) {
      throw new AppError("INTERNAL_ERROR", "Failed to expire stale collection attempt");
    }

    return true;
  }

  const message =
    "Stale recurring collection attempt has a linked transfer but no submission signature; paused for reconciliation";

  await getDb(input.env).transaction(async (tx) => {
    const txPaymentsRepo = createPostgresPaymentsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedTransfer = await txPaymentsRepo.updateTransfer({
      transferId: input.attempt.transfer_id ?? "",
      status: "failed",
      error: message,
      updatedAt: now,
    });
    const failedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
      attemptId: input.attempt.id,
      transferId: input.attempt.transfer_id,
      status: "failed",
      error: message,
      attemptedAt: now,
      updatedAt: now,
    });
    const pausedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: input.recurringPayment.status,
      status: "paused",
      updatedAt: now,
    });
    const pausedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: "active",
      status: "paused",
      updatedAt: now,
    });

    if (!updatedTransfer || !failedAttempt || !pausedRecurringPayment || !pausedSubscription) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to pause recurring payment with ambiguous collection attempt"
      );
    }
  });

  console.warn("Recurring payment paused for collection reconciliation", {
    recurringPaymentId: input.recurringPayment.id,
    attemptId: input.attempt.id,
    transferId: input.attempt.transfer_id,
  });

  throw new AppError(
    "CONFLICT",
    "Recurring payment collection paused for reconciliation after an ambiguous submission state"
  );
}

async function recoverActiveCollectionAttemptOrThrow(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
  attempt: PaymentSubscriptionCollectionAttemptRow | null;
  retryAfter: string;
}): Promise<CollectionResult | null> {
  if (!input.attempt || !isActiveCollectionAttempt(input.attempt)) {
    return null;
  }

  const recovered = await recoverSubmittedRecurringCollection({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    dueAt: input.dueAt,
    attempt: input.attempt,
  });
  if (recovered) {
    return recovered;
  }

  const staleAttemptExpired = await resolveStaleUnsignedProcessingAttempt({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscriptionId: input.subscriptionId,
    attempt: input.attempt,
    retryAfter: input.retryAfter,
  });
  if (staleAttemptExpired) {
    return null;
  }

  throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
}

async function createProcessingCollectionAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscriptionId: string;
  dueAt: string;
}): Promise<PaymentSubscriptionCollectionAttemptRow> {
  const now = new Date().toISOString();
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const attempt = await subscriptionsRepo.createCollectionAttempt({
    id: `psca_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    subscriptionId: input.subscriptionId,
    recurringPaymentId: input.recurringPayment.id,
    transferId: null,
    token: input.recurringPayment.token,
    amount: input.recurringPayment.amount,
    dueAt: input.dueAt,
    attemptedAt: now,
    status: "processing",
    signature: null,
    error: null,
    metadata: { source: "recurring_payments" },
    createdAt: now,
    updatedAt: now,
  });

  if (!attempt) {
    throw new AppError("INTERNAL_ERROR", "Failed to create collection attempt");
  }

  return attempt;
}

async function createTransferAndLinkCollectionAttempt(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  initiatedByKeyId?: string | null;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  let transferId: string | null = null;

  try {
    return await getDb(input.env).transaction(async (tx) => {
      const txPaymentsRepo = createPostgresPaymentsRepository(tx);
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const now = new Date().toISOString();
      const transfer = await createTransferRecord({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment: input.recurringPayment,
        status: "processing",
        initiatedByKeyId: input.initiatedByKeyId ?? null,
        paymentsRepo: txPaymentsRepo,
        createdAt: now,
      });
      transferId = transfer.id;
      const attempt = await txSubscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        transferId: transfer.id,
        status: "processing",
        attemptedAt: now,
        updatedAt: now,
      });

      if (!attempt) {
        throw new AppError("INTERNAL_ERROR", "Failed to update collection attempt");
      }

      return { attempt, transfer };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await getDb(input.env).transaction(async (tx) => {
        const txPaymentsRepo = createPostgresPaymentsRepository(tx);
        const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
        const now = new Date().toISOString();
        await txSubscriptionsRepo.updateCollectionAttempt({
          attemptId: input.attempt.id,
          transferId,
          status: "failed",
          error: message,
          attemptedAt: now,
          updatedAt: now,
        });
        if (transferId) {
          await txPaymentsRepo.updateTransfer({
            transferId,
            status: "failed",
            error: message,
            updatedAt: now,
          });
        }
      });
    } catch (cleanupError) {
      console.warn("Failed to mark collection attempt failed after transfer-link error", {
        recurringPaymentId: input.recurringPayment.id,
        attemptId: input.attempt.id,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    throw error;
  }
}

export async function createRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string | null;
  metadataUri?: string | null;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  assertSubscriptionTokenMint(input.token);

  const destination = await resolveSolanaCounterpartyAccount({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
  });
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: input.sourceWallet,
    destinationAddress: destination.destinationAddress,
    enforceDailyLimit: false,
    token: input.token,
    amount: input.amount,
  });

  const now = new Date().toISOString();
  const recurringPayment = await createPaymentRecurringPaymentsRepository(
    input.env
  ).createRecurringPayment({
    id: `prp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.sourceWallet.walletId,
    sourceAddress: input.sourceWallet.publicKey,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token: input.token,
    amount: input.amount,
    periodHours: input.periodHours,
    firstCollectionAt: input.firstCollectionAt ?? null,
    metadataUri: input.metadataUri ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!recurringPayment) {
    throw new AppError("INTERNAL_ERROR", "Failed to create recurring payment");
  }

  return recurringPayment;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}): Promise<ActivationResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  let recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status === "active") {
    return { recurringPayment };
  }
  if (
    recurringPayment.status !== "pending_activation" &&
    recurringPayment.status !== "activating"
  ) {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payment cannot be activated from its current status"
    );
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const destinationTokenAccount = await deriveAssociatedTokenAccount({
    owner: destinationAddress,
    runtime,
  });

  const activation = await claimActivationRecords({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: recurringPayment.id,
    destinationTokenAccount,
    subscriberTokenAccount: runtime.sourceTokenAccount,
  });

  if (activation.alreadyActive) {
    return { recurringPayment: activation.recurringPayment };
  }

  recurringPayment = activation.recurringPayment;
  const { plan, subscription } = activation;

  const onChainPlan = await ensureSubscriptionPlanOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    destinationTokenAccount,
    programPlanId: plan.program_plan_id,
    metadataUri: recurringPayment.metadata_uri ?? "",
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature: recurringPayment.plan_creation_signature,
  });

  const onChainAuthorization = await ensureSubscriptionAuthorizationOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    sourceTokenAccount: runtime.sourceTokenAccount,
    planId: onChainPlan.planId,
    planPda: onChainPlan.planPda,
    planCreatedAt: onChainPlan.planCreatedAt,
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature:
      recurringPayment.authorization_signature ?? subscription.authorization_signature,
  });
  const activationNow = new Date().toISOString();
  const dueAt = recurringPayment.first_collection_at
    ? advanceCollectionDueAtAfter({
        nextCollectionDueAt: recurringPayment.first_collection_at,
        periodHours: recurringPayment.period_hours,
        after: activationNow,
      })
    : activationNow;
  const claimedRecurringPayment = recurringPayment;
  recurringPayment = await getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedPlan = await txSubscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda: onChainPlan.planPda,
      destinationAddress: destinationTokenAccount,
      pullerWalletId: claimedRecurringPayment.source_wallet_id,
      pullerAddress: claimedRecurringPayment.source_address,
      status: "active",
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: runtime.sourceTokenAccount,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ?? subscription.authorization_signature,
      status: "active",
      currentPeriodStartAt: dueAt,
      nextCollectionDueAt: dueAt,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: claimedRecurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount,
      nextCollectionDueAt: dueAt,
      planId: plan.id,
      subscriptionId: subscription.id,
      planPda: onChainPlan.planPda,
      planCreatedAt: onChainPlan.planCreatedAt.toString(),
      planCreationSignature:
        onChainPlan.signature ?? claimedRecurringPayment.plan_creation_signature ?? null,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ??
        claimedRecurringPayment.authorization_signature ??
        subscription.authorization_signature ??
        null,
      status: "active",
      updatedAt,
    });

    if (!updatedPlan || !updatedSubscription || !updatedRecurringPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to activate subscription records");
    }

    return updatedRecurringPayment;
  });

  return {
    recurringPayment,
    planSignature: onChainPlan.signature,
    authorizationSignature: onChainAuthorization.signature,
  };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  initiatedByKeyId?: string | null;
  enforceDue?: boolean;
  sourceWallet?: CustodyWallet;
}): Promise<CollectionResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Recurring payment must be active before collection");
  }
  if (
    !recurringPayment.subscription_id ||
    !recurringPayment.plan_pda ||
    !recurringPayment.subscription_pda
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (!recurringPayment.next_collection_due_at) {
    throw new AppError("BAD_REQUEST", "Recurring payment has no due collection");
  }

  const subscriptionId = recurringPayment.subscription_id;
  const dueAt = recurringPayment.next_collection_due_at;
  const retryAfter = getCollectionRetryAfter(input.env);
  if (input.enforceDue !== false && new Date(dueAt).getTime() > Date.now()) {
    throw new AppError("BAD_REQUEST", "Recurring payment is not due for collection");
  }

  let attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
    recurringPaymentId: recurringPayment.id,
    dueAt,
  });

  const recoveredExisting = await recoverActiveCollectionAttemptOrThrow({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    subscriptionId,
    dueAt,
    attempt,
    retryAfter,
  });
  if (recoveredExisting) {
    return recoveredExisting;
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const sourceWallet =
    input.sourceWallet ??
    (await resolveSourceWalletForExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: recurringPayment.source_wallet_id,
    }));
  try {
    await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
      organizationId: input.organizationId,
      projectId: input.projectId,
      wallet: sourceWallet,
      destinationAddress,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
    });
  } catch (error) {
    await createFailedCollectionAttemptForRetry({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      error: error instanceof Error ? error.message : String(error),
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });

    throw error;
  }
  const planPda = assertValidAddress(recurringPayment.plan_pda, "planPda");
  const subscriptionPda = assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);

  try {
    attempt = await createProcessingCollectionAttempt({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
    });
  } catch (error) {
    const conflictingAttempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
      recurringPaymentId: recurringPayment.id,
      dueAt,
    });
    const recoveredConflict = await recoverActiveCollectionAttemptOrThrow({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      dueAt,
      attempt: conflictingAttempt,
      retryAfter,
    });
    if (recoveredConflict) {
      return recoveredConflict;
    }

    throw error;
  }

  const linked = await createTransferAndLinkCollectionAttempt({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment,
    attempt,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
  });
  attempt = linked.attempt;
  let transfer = linked.transfer;

  let executed: Awaited<ReturnType<typeof collectSubscriptionOnChain>>;
  try {
    executed = await collectSubscriptionOnChain({
      env: input.env,
      sourceSigner,
      sourceAddress,
      destinationAddress,
      planPda,
      subscriptionPda,
      runtime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTransferRecord({
      env: input.env,
      transferId: transfer.id,
      status: "failed",
      error: message,
    });
    const failedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: attempt.id,
      transferId: transfer.id,
      status: "failed",
      error: message,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (failedAttempt) {
      attempt = failedAttempt;
    }

    throw error;
  }

  let submitted = await markRecurringCollectionSubmitted({
    env: input.env,
    attempt,
    transfer,
    signature: executed.signature,
    slot: executed.slot,
    blockTime: executed.blockTime,
    destinationTokenAccount: String(executed.destinationTokenAccount),
  });
  attempt = submitted.attempt;
  transfer = submitted.transfer;

  try {
    return await finalizeRecurringCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      subscriptionId,
      attempt,
      transfer,
      dueAt,
      signature: executed.signature,
      slot: executed.slot,
      blockTime: executed.blockTime,
      destinationTokenAccount: String(executed.destinationTokenAccount),
    });
  } catch (error) {
    if (!submitted.hasAttemptRecoveryMarker) {
      submitted = await markRecurringCollectionSubmitted({
        env: input.env,
        attempt,
        transfer,
        signature: executed.signature,
        slot: executed.slot,
        blockTime: executed.blockTime,
        destinationTokenAccount: String(executed.destinationTokenAccount),
      });
      attempt = submitted.attempt;
      transfer = submitted.transfer;
    }
    console.error("Recurring collection finalized on-chain but DB finalization failed", {
      recurringPaymentId: recurringPayment.id,
      attemptId: attempt.id,
      transferId: transfer.id,
      signature: executed.signature,
      hasRecoveryMarker: submitted.hasRecoveryMarker,
      hasAttemptRecoveryMarker: submitted.hasAttemptRecoveryMarker,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

export async function executeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: "cancel" | "resume";
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  const subscriptionId = recurringPayment.subscription_id;
  if (!subscriptionId || !recurringPayment.plan_pda || !recurringPayment.subscription_pda) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (
    input.operation === "cancel" &&
    recurringPayment.status !== "active" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only active or paused recurring payments can be canceled");
  }
  if (
    input.operation === "resume" &&
    recurringPayment.status !== "canceled" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only canceled or paused recurring payments can be resumed");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  await executeSubscriptionLifecycleOnChain({
    env: input.env,
    operation: input.operation,
    sourceSigner,
    planPda: assertValidAddress(recurringPayment.plan_pda, "planPda"),
    subscriptionPda: assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda"),
  });

  const now = new Date().toISOString();
  const status = input.operation === "cancel" ? "canceled" : "active";
  const resumeNextCollectionDueAt =
    input.operation === "resume"
      ? advanceCollectionDueAtAfter({
          nextCollectionDueAt: recurringPayment.next_collection_due_at,
          periodHours: recurringPayment.period_hours,
          after: now,
        })
      : undefined;
  const resumeCurrentPeriodStartAt =
    resumeNextCollectionDueAt === undefined
      ? undefined
      : addPeriodHours(resumeNextCollectionDueAt, -recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updated = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: recurringPayment.status,
      expectedNextCollectionDueAt: recurringPayment.next_collection_due_at,
      status,
      nextCollectionDueAt: resumeNextCollectionDueAt,
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus:
        recurringPayment.status === "paused"
          ? "paused"
          : recurringPayment.status === "canceled"
            ? "canceled"
            : "active",
      expectedNextCollectionDueAt: recurringPayment.next_collection_due_at,
      status,
      currentPeriodStartAt: resumeCurrentPeriodStartAt,
      nextCollectionDueAt: resumeNextCollectionDueAt,
      canceledAt:
        input.operation === "cancel" ? now : input.operation === "resume" ? null : undefined,
      updatedAt: now,
    });

    if (!updated || !updatedSubscription) {
      throw new AppError(
        "CONFLICT",
        "Recurring payment lifecycle state changed before the update completed"
      );
    }

    return updated;
  });
}
