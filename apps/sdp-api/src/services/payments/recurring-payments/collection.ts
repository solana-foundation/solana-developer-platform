import { createFeePaymentAdapter } from "@sdp/payments/fee-payment";
import {
  hasRecurringPaymentAdvancedPastDueAt,
  isRecurringPaymentCollectionActive,
  nextRecurringPaymentCollectionDueAt,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { type Address, createNoopSigner, type Signature } from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import { getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  createPostgresPaymentsRepository,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  type PaymentSubscriptionCollectionAttemptRow,
  type PaymentSubscriptionRow,
  type PaymentSubscriptionsRepository,
  type PaymentTransferRow,
} from "@/db/repositories";
import { AppError, badRequest } from "@/lib/errors";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
  parsePositiveIntegerConfig,
} from "../recurring-payment-config";
import { assertWalletPolicyAllowsTransferWithRepository } from "../wallet-policy";
import {
  activationErrorMessage,
  confirmSubscriptionSignature,
  sendSubscriptionInstructions,
} from "./shared";

const COLLECTION_STALE_AFTER_MS = RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS;

type RecurringCollectionSource = "manual" | "automated";

function hasStoppedSubscriptionCollections(row: PaymentSubscriptionRow): boolean {
  return row.status !== "active";
}

function isStaleCollectionAttempt(row: PaymentSubscriptionCollectionAttemptRow): boolean {
  const updatedAt = new Date(row.updated_at).getTime();
  return Number.isFinite(updatedAt) && updatedAt <= Date.now() - COLLECTION_STALE_AFTER_MS;
}

function isRecurringCollectionSource(value: unknown): value is RecurringCollectionSource {
  return value === "manual" || value === "automated";
}

function recurringCollectionMetadata(input: {
  metadata?: Record<string, unknown>;
  recurringPaymentId: string;
  transferId?: string | null;
  collectionSource?: RecurringCollectionSource;
  initiatedByKeyId?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = { ...(input.metadata ?? {}) };
  const source =
    input.collectionSource ??
    (isRecurringCollectionSource(metadata.collectionSource)
      ? metadata.collectionSource
      : undefined);
  const initiatedByKeyId =
    input.initiatedByKeyId ??
    (typeof metadata.initiatedByKeyId === "string" ? metadata.initiatedByKeyId : undefined);

  return {
    ...metadata,
    recurringPaymentId: input.recurringPaymentId,
    ...(input.transferId ? { transferId: input.transferId } : {}),
    ...(source ? { collectionSource: source } : {}),
    ...(initiatedByKeyId ? { initiatedByKeyId } : {}),
    ...(input.extra ?? {}),
  };
}

async function resolveDestinationTokenAccount(input: {
  env: Env;
  destinationAddress: string;
  token: string;
}): Promise<Address> {
  const rpc = solanaRpc.createRpc(input.env);
  const destinationOwner = assertValidAddress(input.destinationAddress, "destinationAddress");
  const mint = assertValidAddress(input.token, "token") as Address;
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const [receiverAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram,
    mint,
  });
  return receiverAta;
}

function collectionRetryMetadata(env: Env, error: unknown): Record<string, unknown> {
  const retryAfterMinutes = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES
  );
  return {
    error: activationErrorMessage(error),
    retryAfterAt: new Date(Date.now() + retryAfterMinutes * 60 * 1000).toISOString(),
  };
}

/**
 * Atomically settles a failed collection attempt and its linked transfer.
 *
 * Keep these status writes in one database transaction. Splitting them into
 * independent repository calls can strand a processing transfer behind a failed
 * attempt and block the due-period retry path.
 */
async function markRecurringPaymentCollectionFailedAtomically(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow | null;
  submittedSignature: Signature | null;
  error: unknown;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  const message = activationErrorMessage(input.error);
  const metadata = recurringCollectionMetadata({
    metadata: input.attempt.metadata,
    recurringPaymentId: input.recurringPaymentId,
    transferId: input.transfer?.id ?? null,
    extra: collectionRetryMetadata(input.env, input.error),
  });

  await getDb(input.env).transaction(async (tx) => {
    let confirmedTransferSignature: Signature | null = null;

    if (input.transfer) {
      const transferRows = await tx
        .prepare(
          `UPDATE payment_transfers
              SET status = 'failed',
                  signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                  error = ?,
                  updated_at = ?
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status IN ('pending', 'processing', 'failed')`
        )
        .bind(
          input.submittedSignature !== null,
          input.submittedSignature,
          message,
          failedAt,
          input.transfer.id,
          input.organizationId,
          input.projectId
        )
        .run();
      if (transferRows === 0) {
        const currentTransfer = await tx
          .prepare(
            `SELECT status, signature
               FROM payment_transfers
              WHERE id = ?
                AND organization_id = ?
                AND project_id = ?`
          )
          .bind(input.transfer.id, input.organizationId, input.projectId)
          .first<{ status: string; signature: string | null }>();

        if (currentTransfer?.status !== "confirmed") {
          throw new AppError("INTERNAL_ERROR", "Failed to mark collection transfer failed");
        }

        confirmedTransferSignature = (currentTransfer.signature ??
          input.submittedSignature) as Signature | null;
        if (!confirmedTransferSignature) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Confirmed collection transfer is missing signature"
          );
        }
      }
    }

    const attemptStatus = confirmedTransferSignature ? "confirmed" : "failed";
    const attemptSignature = confirmedTransferSignature ?? input.submittedSignature;
    const attemptError = confirmedTransferSignature ? null : message;
    const attemptMetadata = confirmedTransferSignature
      ? recurringCollectionMetadata({
          metadata: input.attempt.metadata,
          recurringPaymentId: input.recurringPaymentId,
          transferId: input.transfer?.id ?? null,
        })
      : metadata;

    const attemptRows = await tx
      .prepare(
        `UPDATE payment_subscription_collection_attempts
            SET transfer_id = CASE WHEN ?::boolean THEN ? ELSE transfer_id END,
                status = ?,
                signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                error = ?,
                metadata = ?::jsonb,
                updated_at = ?
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND (
              (?::text = 'confirmed' AND status IN ('pending', 'processing', 'confirmed'))
              OR (?::text = 'failed' AND status IN ('pending', 'processing', 'failed'))
            )`
      )
      .bind(
        input.transfer !== null,
        input.transfer?.id ?? null,
        attemptStatus,
        attemptSignature !== null,
        attemptSignature,
        attemptError,
        JSON.stringify(attemptMetadata),
        failedAt,
        input.attempt.id,
        input.organizationId,
        input.projectId,
        attemptStatus,
        attemptStatus
      )
      .run();
    if (attemptRows === 0) {
      throw new AppError("INTERNAL_ERROR", "Failed to mark collection attempt failed");
    }
  });
}

async function finalizeRecurringPaymentCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
  destinationTokenAccount?: string | null;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  const finalizedAt = new Date().toISOString();
  const dueAt = input.attempt.due_at;
  const nextDueAt = nextRecurringPaymentCollectionDueAt(dueAt, input.recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    // Keep the externally submitted artifacts durable before advancing the due period.
    // Recovery can safely re-run this transaction because the period updates below are CAS-guarded.
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const paymentsRepo = createPostgresPaymentsRepository(tx);

    const updatedTransfer = await paymentsRepo.updateTransfer({
      transferId: input.transfer.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      signature: input.signature,
      error: null,
      updatedAt: finalizedAt,
    });
    const finalizedTransfer =
      updatedTransfer ??
      (await paymentsRepo.getTransferById({
        transferId: input.transfer.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));
    const updatedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      transferId: input.transfer.id,
      status: "confirmed",
      signature: input.signature,
      error: null,
      metadata: recurringCollectionMetadata({
        metadata: input.attempt.metadata,
        recurringPaymentId: input.recurringPayment.id,
        transferId: input.transfer.id,
      }),
      updatedAt: finalizedAt,
    });
    const finalizedAttempt =
      updatedAttempt ??
      (await subscriptionsRepo.getCollectionAttemptById({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));
    const updatedSubscription = await subscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentPeriodStartAt: dueAt,
      nextCollectionDueAt: nextDueAt,
      expectedNextCollectionDueAt: dueAt,
      expectedStatus: "active",
      updatedAt: finalizedAt,
    });
    const finalizedSubscription =
      updatedSubscription ??
      (await subscriptionsRepo.getSubscriptionById({
        subscriptionId: input.subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));
    const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentCollection({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentCollectionDueAt: dueAt,
      nextCollectionDueAt: nextDueAt,
      destinationTokenAccount: input.destinationTokenAccount,
      updatedAt: finalizedAt,
    });
    const finalizedRecurringPayment =
      updatedRecurringPayment ??
      (await recurringRepo.getRecurringPaymentById({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));

    if (
      !finalizedRecurringPayment ||
      (!updatedRecurringPayment &&
        isRecurringPaymentCollectionActive(finalizedRecurringPayment.status) &&
        !hasRecurringPaymentAdvancedPastDueAt(
          finalizedRecurringPayment.next_collection_due_at,
          dueAt
        )) ||
      !finalizedSubscription ||
      (!updatedSubscription &&
        !hasStoppedSubscriptionCollections(finalizedSubscription) &&
        !hasRecurringPaymentAdvancedPastDueAt(
          finalizedSubscription.next_collection_due_at,
          dueAt
        )) ||
      !finalizedAttempt ||
      finalizedAttempt.status !== "confirmed" ||
      finalizedAttempt.signature !== input.signature ||
      finalizedAttempt.transfer_id !== input.transfer.id ||
      !finalizedTransfer ||
      finalizedTransfer.status !== "confirmed" ||
      finalizedTransfer.signature !== input.signature
    ) {
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment collection");
    }

    return {
      recurringPayment: finalizedRecurringPayment,
      subscription: finalizedSubscription,
      collectionAttempt: finalizedAttempt,
      transfer: finalizedTransfer,
    };
  });
}

async function journalRecurringPaymentCollectionError(input: {
  env: Env;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  paymentsRepo: ReturnType<typeof createPaymentsRepository>;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow | null;
  submittedSignature: Signature | null;
  error: unknown;
}): Promise<void> {
  if (
    input.submittedSignature &&
    !(input.error instanceof AppError && input.error.code === "TRANSACTION_FAILED")
  ) {
    const updatedAt = new Date().toISOString();
    const [attemptResult, transferResult] = await Promise.allSettled([
      input.subscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(input.transfer ? { transferId: input.transfer.id } : {}),
        signature: input.submittedSignature,
        updatedAt,
      }),
      input.transfer
        ? input.paymentsRepo.updateTransfer({
            transferId: input.transfer.id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            signature: input.submittedSignature,
            updatedAt,
          })
        : Promise.resolve(null),
    ]);
    const attemptJournaled =
      attemptResult.status === "fulfilled" &&
      attemptResult.value?.signature === input.submittedSignature;
    const transferJournaled =
      transferResult.status === "fulfilled" &&
      transferResult.value?.signature === input.submittedSignature;
    if (!attemptJournaled && !transferJournaled) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to journal submitted recurring payment collection signature"
      );
    }
    if (input.transfer && attemptJournaled !== transferJournaled) {
      console.error("Partially journaled submitted recurring payment collection signature", {
        attemptId: input.attempt.id,
        attemptJournaled,
        attemptJournalError:
          attemptResult.status === "rejected" ? activationErrorMessage(attemptResult.reason) : null,
        recurringPaymentId: input.recurringPaymentId,
        submittedSignature: input.submittedSignature,
        transferId: input.transfer.id,
        transferJournaled,
        transferJournalError:
          transferResult.status === "rejected"
            ? activationErrorMessage(transferResult.reason)
            : null,
      });
    }
    return;
  }

  await markRecurringPaymentCollectionFailedAtomically(input);
}

async function safeJournalRecurringPaymentCollectionError(input: {
  env: Env;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  paymentsRepo: ReturnType<typeof createPaymentsRepository>;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow | null;
  submittedSignature: Signature | null;
  error: unknown;
}): Promise<void> {
  try {
    await journalRecurringPaymentCollectionError(input);
  } catch (journalError) {
    console.error("Failed to journal recurring payment collection after failure", {
      attemptId: input.attempt.id,
      error: activationErrorMessage(journalError),
      hasSubmittedSignature: input.submittedSignature !== null,
      originalError: activationErrorMessage(input.error),
      recurringPaymentId: input.recurringPaymentId,
      transferId: input.transfer?.id ?? null,
    });
  }
}

async function recoverRecurringPaymentCollection(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  paymentsRepo: ReturnType<typeof createPaymentsRepository>;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  dueAt: string;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
} | null> {
  const existing = await input.subscriptionsRepo.getCollectionAttemptByDue({
    organizationId: input.organizationId,
    projectId: input.projectId,
    subscriptionId: input.subscription.id,
    dueAt: input.dueAt,
    statuses: ["processing", "confirmed"],
  });
  if (!existing) {
    return null;
  }
  if (!existing.transfer_id) {
    if (!isStaleCollectionAttempt(existing)) {
      throw new AppError("CONFLICT", "Recurring payment collection is already processing");
    }
    await markRecurringPaymentCollectionFailedAtomically({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attempt: existing,
      transfer: null,
      submittedSignature: null,
      error: new Error("Recurring payment collection was interrupted before transfer creation"),
    });
    return null;
  }

  const transfer = await input.paymentsRepo.getTransferById({
    transferId: existing.transfer_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Recurring payment collection transfer not found");
  }
  const recoveredSignature = existing.signature ?? transfer.signature;
  if (!recoveredSignature) {
    // A fresh unsigned attempt means another request is between local persistence and Kora
    // submission; wait for it to either submit or become stale instead of creating a second transfer.
    if (!isStaleCollectionAttempt(existing)) {
      throw new AppError("CONFLICT", "Recurring payment collection is already processing");
    }
    await markRecurringPaymentCollectionFailedAtomically({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attempt: existing,
      transfer,
      submittedSignature: null,
      error: new Error("Recurring payment collection was interrupted before submission"),
    });
    return null;
  }
  const recoveredAttempt =
    existing.signature === recoveredSignature
      ? existing
      : { ...existing, signature: recoveredSignature };

  if (existing.status === "processing" && transfer.status !== "confirmed") {
    try {
      await confirmSubscriptionSignature(
        input.env,
        recoveredSignature as Signature,
        "Recurring payment collection failed on-chain"
      );
    } catch (error) {
      await markRecurringPaymentCollectionFailedAtomically({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        attempt: existing,
        transfer,
        submittedSignature: recoveredSignature as Signature,
        error,
      });
      if (error instanceof AppError && error.code === "TRANSACTION_FAILED") {
        return null;
      }
      throw error;
    }
  }

  const currentRecurringPayment =
    (await input.recurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    })) ?? input.recurringPayment;
  const currentSubscription =
    (await input.subscriptionsRepo.getSubscriptionById({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    })) ?? input.subscription;
  const destinationTokenAccount =
    currentRecurringPayment.destination_token_account ??
    (await resolveDestinationTokenAccount({
      env: input.env,
      destinationAddress: currentRecurringPayment.destination_address,
      token: currentRecurringPayment.token,
    }));

  return finalizeRecurringPaymentCollection({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: currentRecurringPayment,
    subscription: currentSubscription,
    attempt: recoveredAttempt,
    transfer,
    signature: recoveredSignature as Signature,
    destinationTokenAccount,
  });
}

export async function recoverOrBlockLifecycleCollection(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  paymentsRepo: ReturnType<typeof createPaymentsRepository>;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
}> {
  if (!input.recurringPayment.subscription_id || !input.recurringPayment.next_collection_due_at) {
    return { recurringPayment: input.recurringPayment, subscription: null };
  }

  const subscription = await input.subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.recurringPayment.subscription_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!subscription) {
    return { recurringPayment: input.recurringPayment, subscription: null };
  }

  const recovered = await recoverRecurringPaymentCollection({
    env: input.env,
    recurringRepo: input.recurringRepo,
    subscriptionsRepo: input.subscriptionsRepo,
    paymentsRepo: input.paymentsRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPayment: input.recurringPayment,
    subscription,
    dueAt: input.recurringPayment.next_collection_due_at,
  });

  if (recovered) {
    return {
      recurringPayment: recovered.recurringPayment,
      subscription: recovered.subscription,
    };
  }

  return { recurringPayment: input.recurringPayment, subscription };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  initiatedByKeyId: string | null;
  collectionSource?: RecurringCollectionSource;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  if (input.recurringPayment.source_wallet_id !== input.sourceWallet.walletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }
  if (input.recurringPayment.source_address !== input.sourceWallet.publicKey) {
    throw badRequest("Recurring payment source address does not match wallet");
  }
  if (!input.recurringPayment.plan_id || !input.recurringPayment.subscription_id) {
    throw new AppError("CONFLICT", "Recurring payment is missing subscription records");
  }
  if (!input.recurringPayment.plan_pda || !input.recurringPayment.subscription_pda) {
    throw new AppError("CONFLICT", "Recurring payment is missing on-chain subscription records");
  }
  if (!input.recurringPayment.next_collection_due_at) {
    throw new AppError("CONFLICT", "Recurring payment has no due collection");
  }

  const nowIso = new Date().toISOString();
  const dueAt = input.recurringPayment.next_collection_due_at;

  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const paymentsRepo = createPaymentsRepository(input.env);
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscription = await subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.recurringPayment.subscription_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!subscription) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  let attempt: PaymentSubscriptionCollectionAttemptRow | null = null;
  let transfer: PaymentTransferRow | null = null;
  let submittedSignature: Signature | null = null;
  try {
    const recovered = await recoverRecurringPaymentCollection({
      env: input.env,
      recurringRepo,
      subscriptionsRepo,
      paymentsRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      subscription,
      dueAt,
    });
    if (recovered) {
      return recovered;
    }

    if (input.recurringPayment.status !== "active") {
      throw new AppError("CONFLICT", "Recurring payment must be active before collection");
    }
    if (new Date(dueAt).getTime() > Date.now()) {
      throw badRequest("Recurring payment collection is not due yet");
    }

    const plan = await subscriptionsRepo.getPlanById({
      planId: input.recurringPayment.plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!plan) {
      throw new AppError("NOT_FOUND", "Subscription plan not found");
    }
    if (plan.status !== "active") {
      throw badRequest("Subscription plan must be active before collection");
    }
    if (subscription.status !== "active") {
      throw badRequest("Subscription must be active before collection");
    }

    attempt = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: subscription.id,
      transferId: null,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      dueAt,
      attemptedAt: nowIso,
      status: "processing",
      signature: null,
      error: null,
      metadata: recurringCollectionMetadata({
        recurringPaymentId: input.recurringPayment.id,
        collectionSource: input.collectionSource,
        initiatedByKeyId: input.initiatedByKeyId,
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    if (!attempt) {
      const recoveredAfterConflict = await recoverRecurringPaymentCollection({
        env: input.env,
        recurringRepo,
        subscriptionsRepo,
        paymentsRepo,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment: input.recurringPayment,
        subscription,
        dueAt,
      });
      if (recoveredAfterConflict) {
        return recoveredAfterConflict;
      }
      throw new AppError("CONFLICT", "Recurring payment collection is already processing");
    }

    await assertWalletPolicyAllowsTransferWithRepository(paymentsRepo, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      wallet: input.sourceWallet,
      destinationAddress: input.recurringPayment.destination_address,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
    });

    transfer = await paymentsRepo.createTransfer({
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletId: input.sourceWallet.walletId,
      counterpartyId: input.recurringPayment.counterparty_id,
      sourceAddress: input.sourceWallet.publicKey,
      destinationAddress: input.recurringPayment.destination_address,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {
        recurringPaymentId: input.recurringPayment.id,
        subscriptionId: subscription.id,
        collectionDueAt: dueAt,
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: input.initiatedByKeyId,
    });
    if (!transfer) {
      throw new AppError("INTERNAL_ERROR", "Failed to create collection transfer");
    }
    attempt =
      (await subscriptionsRepo.updateCollectionAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        transferId: transfer.id,
        status: "processing",
        updatedAt: new Date().toISOString(),
      })) ?? attempt;

    const rpc = solanaRpc.createRpc(input.env);
    const sourceOwner = assertValidAddress(input.recurringPayment.source_address, "sourceAddress");
    const destinationOwner = assertValidAddress(
      input.recurringPayment.destination_address,
      "destinationAddress"
    );
    const mint = assertValidAddress(input.recurringPayment.token, "token") as Address;
    const sourceSigner = await solanaServices.createOrgSigner(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.walletId
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    const tokenProgram = await resolveMintTokenProgram(rpc, mint);
    const sourceTokenAccount = await resolveSourceTokenAccountOrAta(
      rpc,
      sourceOwner,
      mint,
      tokenProgram
    );
    const amountBaseUnits = parseDecimalAmount(
      input.recurringPayment.amount,
      sourceTokenAccount.decimals
    );
    if (amountBaseUnits <= 0n) {
      throw badRequest("Subscription amount must be greater than zero");
    }

    const [receiverAta] = await findAssociatedTokenPda({
      owner: destinationOwner,
      tokenProgram,
      mint,
    });
    const planPda = assertValidAddress(input.recurringPayment.plan_pda, "planPda") as Address;
    const subscriptionPda = assertValidAddress(
      input.recurringPayment.subscription_pda,
      "subscriptionPda"
    ) as Address;
    const feePayer = await createFeePaymentAdapter(input.env).getFeePayer();
    const payer = createNoopSigner(feePayer);
    const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: receiverAta,
      owner: destinationOwner,
      mint,
      tokenProgram,
    });
    const collectInstruction =
      await subscriptionsProgram.getTransferSubscriptionOverlayInstructionAsync({
        amount: amountBaseUnits,
        caller: sourceSigner,
        delegator: sourceOwner,
        planPda,
        receiverAta,
        subscriptionPda,
        tokenMint: mint,
        tokenProgram,
      });

    const recurringPaymentWithDestination =
      await recurringRepo.updateRecurringPaymentDestinationTokenAccount({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        destinationTokenAccount: receiverAta,
        updatedAt: new Date().toISOString(),
      });
    if (!recurringPaymentWithDestination) {
      throw new AppError("CONFLICT", "Recurring payment is no longer active");
    }

    const signature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      sourceSigner,
      instructions: [createDestinationAtaInstruction, collectInstruction],
      feePayer,
    });
    submittedSignature = signature;
    const submittedAt = new Date().toISOString();
    attempt =
      (await subscriptionsRepo.updateCollectionAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature,
        status: "processing",
        error: null,
        updatedAt: submittedAt,
      })) ?? attempt;
    const submittedTransfer = await paymentsRepo.updateTransfer({
      transferId: transfer.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      signature,
      error: null,
      updatedAt: submittedAt,
    });

    if (!submittedTransfer) {
      throw new AppError("INTERNAL_ERROR", "Failed to update collection transfer");
    }
    transfer = submittedTransfer;

    await confirmSubscriptionSignature(
      input.env,
      signature,
      "Recurring payment collection failed on-chain"
    );

    return finalizeRecurringPaymentCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      subscription,
      attempt,
      transfer,
      signature,
      destinationTokenAccount: receiverAta,
    });
  } catch (error) {
    if (attempt) {
      await safeJournalRecurringPaymentCollectionError({
        env: input.env,
        subscriptionsRepo,
        paymentsRepo,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        attempt,
        transfer,
        submittedSignature,
        error,
      });
    }
    throw error;
  }
}
