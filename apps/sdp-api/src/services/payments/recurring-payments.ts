import type { UpdatePaymentRecurringPaymentRequest } from "@sdp/types";
import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
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
  type PaymentRecurringPaymentActivationAttemptRow,
  type PaymentRecurringPaymentActivationAttemptStage,
  type PaymentRecurringPaymentLifecycleAttemptRow,
  type PaymentRecurringPaymentLifecycleAttemptStage,
  type PaymentRecurringPaymentLifecycleOperation,
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentUpdateAttemptMode,
  type PaymentRecurringPaymentUpdateAttemptRow,
  type PaymentSubscriptionCollectionAttemptRow,
  type PaymentSubscriptionPlanRow,
  type PaymentSubscriptionRow,
  type PaymentSubscriptionsRepository,
  type PaymentTransferRow,
} from "@/db/repositories";
import { parseDecimalAmount } from "@/lib/amount";
import { AppError, badRequest } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { normalizePaymentToken, SOL_MINT } from "@/services/payment-operation.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import * as solanaRpc from "@/services/solana/rpc";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";
import {
  DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
  parsePositiveIntegerConfig,
} from "./recurring-payment-config";

const U64_MAX = 18_446_744_073_709_551_615n;
const OPERATION_STALE_AFTER_MS = 15 * 60 * 1000;
const ACTIVATION_STALE_AFTER_MS = OPERATION_STALE_AFTER_MS;
const COLLECTION_STALE_AFTER_MS = OPERATION_STALE_AFTER_MS;
const LIFECYCLE_STALE_AFTER_MS = OPERATION_STALE_AFTER_MS;
const UPDATE_STALE_AFTER_MS = OPERATION_STALE_AFTER_MS;

type RecurringCollectionSource = "manual" | "automated";

function assertRecurringPaymentTokenMint(token: string): string {
  const normalized = normalizePaymentToken(token);
  if (normalized === "SOL" || normalized === SOL_MINT) {
    throw badRequest("Recurring payments require an SPL token mint");
  }

  return assertValidAddress(normalized, "token");
}

function generateProgramPlanId(): string {
  const bytes = new Uint8Array(8);
  let value = 0n;

  while (value === 0n) {
    crypto.getRandomValues(bytes);
    value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
  }

  return value.toString();
}

function parseU64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > U64_MAX) {
      throw new Error("out of range");
    }
    return parsed;
  } catch {
    throw badRequest(`${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

async function sendSubscriptionInstructions(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceSigner?: TransactionSigner;
  instructions: Instruction[];
  feePayer?: Address;
}): Promise<Signature> {
  const signer =
    input.sourceSigner ??
    (await solanaServices.createOrgSigner(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.walletId
    ));

  if (signer.address !== input.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(input.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = createFeePaymentAdapter(input.env);
  const feePayer = input.feePayer ?? (await feePayment.getFeePayer());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
    (m) => addSignersToTransactionMessage([signer], m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  return feePayment.signAndSend(txBytes);
}

async function confirmSubscriptionSignature(
  env: Env,
  signature: Signature,
  message = "Recurring payment activation failed on-chain"
): Promise<void> {
  const rpc = solanaRpc.createRpc(env);
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", message);
  }
}

async function resetRecurringPaymentActivationUnlessAlreadyActive(input: {
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  updatedAt: string;
}): Promise<void> {
  await input.recurringRepo.resetRecurringPaymentActivationIfNotActive({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
  });
}

function activationStaleBefore(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - ACTIVATION_STALE_AFTER_MS).toISOString();
}

function lifecycleStaleBefore(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - LIFECYCLE_STALE_AFTER_MS).toISOString();
}

function updateStaleBefore(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - UPDATE_STALE_AFTER_MS).toISOString();
}

function isStaleActivation(row: PaymentRecurringPaymentRow, nowIso: string): boolean {
  return new Date(row.updated_at).getTime() <= new Date(activationStaleBefore(nowIso)).getTime();
}

function isStaleLifecycle(row: PaymentRecurringPaymentRow, nowIso: string): boolean {
  return new Date(row.updated_at).getTime() <= new Date(lifecycleStaleBefore(nowIso)).getTime();
}

function isStaleUpdate(row: PaymentRecurringPaymentRow, nowIso: string): boolean {
  return new Date(row.updated_at).getTime() <= new Date(updateStaleBefore(nowIso)).getTime();
}

function activationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lifecycleProcessingStatus(operation: PaymentRecurringPaymentLifecycleOperation) {
  return operation === "cancel" ? "canceling" : "resuming";
}

function lifecycleClaimableStatus(operation: PaymentRecurringPaymentLifecycleOperation) {
  return operation === "cancel" ? "active" : "canceled";
}

function lifecycleFinalStatus(operation: PaymentRecurringPaymentLifecycleOperation) {
  return operation === "cancel" ? "canceled" : "active";
}

function lifecycleConfirmationMessage(operation: PaymentRecurringPaymentLifecycleOperation) {
  return operation === "cancel"
    ? "Recurring payment cancellation failed on-chain"
    : "Recurring payment resume failed on-chain";
}

function lifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextCollectionDueAt(dueAt: string, periodHours: number): string {
  return new Date(new Date(dueAt).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

function hasAdvancedPastDueAt(nextDueAt: string | null, dueAt: string): boolean {
  const nextDueTime = nextDueAt ? new Date(nextDueAt).getTime() : NaN;
  const dueTime = new Date(dueAt).getTime();
  return Number.isFinite(nextDueTime) && Number.isFinite(dueTime) && nextDueTime > dueTime;
}

function hasStoppedRecurringCollections(row: PaymentRecurringPaymentRow): boolean {
  return row.status !== "active";
}

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
  const nextDueAt = nextCollectionDueAt(dueAt, input.recurringPayment.period_hours);

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
        !hasStoppedRecurringCollections(finalizedRecurringPayment) &&
        !hasAdvancedPastDueAt(finalizedRecurringPayment.next_collection_due_at, dueAt)) ||
      !finalizedSubscription ||
      (!updatedSubscription &&
        !hasStoppedSubscriptionCollections(finalizedSubscription) &&
        !hasAdvancedPastDueAt(finalizedSubscription.next_collection_due_at, dueAt)) ||
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

async function recoverOrBlockLifecycleCollection(input: {
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

async function getOrCreateActivationPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  destination: string;
  createdBy: string | null;
}): Promise<PaymentSubscriptionPlanRow> {
  const existing = input.claimed.plan_id
    ? await input.subscriptionsRepo.getPlanById({
        planId: input.claimed.plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;

  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const plan = await input.subscriptionsRepo.createPlan({
    id: `psp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerWalletId: input.sourceWallet.walletId,
    ownerAddress: input.sourceWallet.publicKey,
    token: input.claimed.token,
    amount: input.claimed.amount,
    periodHours: input.claimed.period_hours,
    programPlanId: generateProgramPlanId(),
    planPda: null,
    destinationAddress: input.destination,
    pullerWalletId: input.sourceWallet.walletId,
    pullerAddress: input.sourceWallet.publicKey,
    metadataUri: input.claimed.metadata_uri,
    status: "draft",
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt,
  });

  if (!plan) {
    throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
  }

  return plan;
}

async function getOrCreateActivationSubscription(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  planId: string;
  subscriberAddress: string;
  createdBy: string | null;
}): Promise<PaymentSubscriptionRow> {
  const existing = input.claimed.subscription_id
    ? await input.subscriptionsRepo.getSubscriptionById({
        subscriptionId: input.claimed.subscription_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;

  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const created = await input.subscriptionsRepo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.claimed.counterparty_id,
    subscriberAddress: input.subscriberAddress,
    subscriberTokenAccount: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_authorization",
    currentPeriodStartAt: null,
    nextCollectionDueAt: null,
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt,
  });

  if (created) {
    return created;
  }

  const matched = await input.subscriptionsRepo.listSubscriptions({
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.claimed.counterparty_id,
    subscriberAddress: input.subscriberAddress,
    limit: 1,
    offset: 0,
  });

  const subscription = matched.rows[0] ?? null;
  if (!subscription) {
    throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
  }

  return subscription;
}

async function recordActivationFailure(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  error: unknown;
  failedAt: string;
}): Promise<void> {
  await input.recurringRepo.updateActivationAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "failed",
    stage: input.stage,
    error: activationErrorMessage(input.error),
    updatedAt: input.failedAt,
  });

  if (input.error instanceof AppError && input.error.code === "TRANSACTION_FAILED") {
    const shouldClearAuthorizationSignature =
      input.stage === "authorize_subscription" || input.stage === "finalize";
    await input.recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      ...(input.stage === "create_plan" ? { planCreationSignature: null } : {}),
      ...(shouldClearAuthorizationSignature ? { authorizationSignature: null } : {}),
      updatedAt: input.failedAt,
    });
  }

  await resetRecurringPaymentActivationUnlessAlreadyActive({
    recurringRepo: input.recurringRepo,
    recurringPaymentId: input.claimed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.failedAt,
  });
}

function assertLifecyclePreconditions(input: {
  operation: PaymentRecurringPaymentLifecycleOperation;
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

  const processingStatus = lifecycleProcessingStatus(input.operation);
  const claimableStatus = lifecycleClaimableStatus(input.operation);
  const finalStatus = lifecycleFinalStatus(input.operation);

  if (input.recurringPayment.status === finalStatus) {
    return;
  }
  if (input.recurringPayment.status === processingStatus) {
    if (isStaleLifecycle(input.recurringPayment, input.nowIso)) {
      return;
    }
    throw new AppError("CONFLICT", `Recurring payment ${input.operation} is already processing`);
  }
  if (input.recurringPayment.status !== claimableStatus) {
    throw new AppError(
      "CONFLICT",
      `Recurring payment cannot be ${input.operation === "cancel" ? "canceled" : "resumed"} from this status`
    );
  }
}

async function getOrCreateLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  operation: PaymentRecurringPaymentLifecycleOperation;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<PaymentRecurringPaymentLifecycleAttemptRow> {
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
      status: lifecycleClaimableStatus(input.operation),
      expectedStatus: lifecycleProcessingStatus(input.operation),
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }

  if (!attempt) {
    await input.recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: lifecycleClaimableStatus(input.operation),
      expectedStatus: lifecycleProcessingStatus(input.operation),
      updatedAt: new Date().toISOString(),
    });
    throw new AppError("INTERNAL_ERROR", "Failed to journal recurring payment lifecycle");
  }

  return attempt;
}

async function recordLifecycleFailure(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  operation: PaymentRecurringPaymentLifecycleOperation;
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
    await input.recurringRepo.updateRecurringPaymentLifecycle({
      recurringPaymentId: input.attempt.recurring_payment_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: lifecycleClaimableStatus(input.operation),
      expectedStatus: lifecycleProcessingStatus(input.operation),
      updatedAt: input.failedAt,
    });
  }
}

async function preserveRecoverableLifecycleAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  operation: PaymentRecurringPaymentLifecycleOperation;
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
  operation: PaymentRecurringPaymentLifecycleOperation;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentLifecycleAttemptRow;
  signature: Signature;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  const recurringStatus = lifecycleFinalStatus(input.operation);
  const processingStatus = lifecycleProcessingStatus(input.operation);
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

type RecurringPaymentUpdateSnapshot = {
  sourceWalletId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  metadataUri: string | null;
};

type ResolvedRecurringPaymentUpdate = {
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  metadataUri: string | null;
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>;
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
};

const REPLACEMENT_UPDATE_FIELDS = new Set<keyof RecurringPaymentUpdateSnapshot>([
  "sourceWalletId",
  "counterpartyId",
  "counterpartyAccountId",
  "token",
  "amount",
  "periodHours",
]);

function recurringPaymentSnapshot(row: PaymentRecurringPaymentRow): RecurringPaymentUpdateSnapshot {
  return {
    sourceWalletId: row.source_wallet_id,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    token: row.token,
    amount: row.amount,
    periodHours: row.period_hours,
    firstCollectionAt: row.first_collection_at,
    nextCollectionDueAt: row.next_collection_due_at,
    metadataUri: row.metadata_uri,
  };
}

function buildUpdateDiff(
  before: RecurringPaymentUpdateSnapshot,
  after: RecurringPaymentUpdateSnapshot
): {
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>;
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
} {
  const changedFields = (Object.keys(before) as Array<keyof RecurringPaymentUpdateSnapshot>).filter(
    (field) => before[field] !== after[field]
  );
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};

  for (const field of changedFields) {
    beforeValues[field] = before[field];
    afterValues[field] = after[field];
  }

  return { changedFields, beforeValues, afterValues };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameFlatRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return sameStringSet(keys, Object.keys(right)) && keys.every((key) => left[key] === right[key]);
}

function updateAttemptMatchesRequest(
  attempt: PaymentRecurringPaymentUpdateAttemptRow,
  input: {
    changedFields: string[];
    beforeValues: Record<string, unknown>;
    afterValues: Record<string, unknown>;
  }
): boolean {
  return (
    sameStringSet(attempt.changed_fields, input.changedFields) &&
    sameFlatRecord(attempt.before_values, input.beforeValues) &&
    sameFlatRecord(attempt.after_values, input.afterValues)
  );
}

function requestedActiveUpdateMode(
  changedFields: Array<keyof RecurringPaymentUpdateSnapshot>
): PaymentRecurringPaymentUpdateAttemptMode {
  return changedFields.some((field) => REPLACEMENT_UPDATE_FIELDS.has(field))
    ? "replacement"
    : "metadata_schedule";
}

function assertRecurringPaymentUpdateStatus(row: PaymentRecurringPaymentRow, nowIso: string): void {
  if (row.status === "pending_activation" || row.status === "active") {
    return;
  }
  if (row.status === "updating") {
    if (isStaleUpdate(row, nowIso)) {
      return;
    }
    throw new AppError("CONFLICT", "Recurring payment update is already processing");
  }
  if (row.status === "activating") {
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }
  if (row.status === "canceling") {
    throw new AppError("CONFLICT", "Recurring payment cancellation is already processing");
  }
  if (row.status === "resuming") {
    throw new AppError("CONFLICT", "Recurring payment resume is already processing");
  }

  throw new AppError("CONFLICT", "Recurring payment cannot be updated from this status");
}

async function resolveRecurringPaymentUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  nextSourceWallet?: CustodyWallet;
  request: UpdatePaymentRecurringPaymentRequest;
}): Promise<ResolvedRecurringPaymentUpdate> {
  const finalSourceWallet = input.nextSourceWallet ?? input.sourceWallet;
  const requestedSourceWalletId =
    input.request.sourceWalletId ?? input.recurringPayment.source_wallet_id;
  if (finalSourceWallet.walletId !== requestedSourceWalletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }

  const token =
    input.request.token !== undefined
      ? assertRecurringPaymentTokenMint(input.request.token)
      : input.recurringPayment.token;
  const counterpartyId = input.request.counterpartyId ?? input.recurringPayment.counterparty_id;
  const counterpartyAccountId =
    input.request.counterpartyAccountId ?? input.recurringPayment.counterparty_account_id;
  const accountChanged =
    counterpartyId !== input.recurringPayment.counterparty_id ||
    counterpartyAccountId !== input.recurringPayment.counterparty_account_id;
  const destination = accountChanged
    ? await resolveSolanaCounterpartyAccount({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        counterpartyId,
        counterpartyAccountId,
      })
    : { destinationAddress: input.recurringPayment.destination_address };
  const amount = input.request.amount ?? input.recurringPayment.amount;
  const periodHours = input.request.periodHours ?? input.recurringPayment.period_hours;
  const firstCollectionAt =
    input.request.firstCollectionAt !== undefined
      ? input.request.firstCollectionAt
      : input.recurringPayment.first_collection_at;
  const nextCollectionDueAt =
    input.request.nextCollectionDueAt !== undefined
      ? input.request.nextCollectionDueAt
      : input.recurringPayment.next_collection_due_at;
  const metadataUri =
    input.request.metadataUri !== undefined
      ? input.request.metadataUri
      : input.recurringPayment.metadata_uri;

  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: finalSourceWallet,
    destinationAddress: destination.destinationAddress,
    enforceDailyLimit: false,
    token,
    amount,
  });

  const before = recurringPaymentSnapshot(input.recurringPayment);
  const after: RecurringPaymentUpdateSnapshot = {
    sourceWalletId: finalSourceWallet.walletId,
    counterpartyId,
    counterpartyAccountId,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
  };
  const diff = buildUpdateDiff(before, after);

  return {
    sourceWallet: finalSourceWallet,
    counterpartyId,
    counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token,
    amount,
    periodHours,
    firstCollectionAt,
    nextCollectionDueAt,
    metadataUri,
    ...diff,
  };
}

async function recordRecurringPaymentUpdateEvent(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string | null;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}): Promise<void> {
  const event = await input.recurringRepo.createUpdateEvent({
    id: `prue_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attemptId,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });

  if (!event) {
    throw new AppError("INTERNAL_ERROR", "Failed to journal recurring payment update");
  }
}

async function updatePendingRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.resolved.changedFields.length === 0) {
    return input.recurringPayment;
  }

  const changedDestinationOrToken =
    input.resolved.destinationAddress !== input.recurringPayment.destination_address ||
    input.resolved.token !== input.recurringPayment.token;
  const updatedAt = new Date().toISOString();
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const updated = await recurringRepo.updateRecurringPayment({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.resolved.sourceWallet.walletId,
    sourceAddress: input.resolved.sourceWallet.publicKey,
    counterpartyId: input.resolved.counterpartyId,
    counterpartyAccountId: input.resolved.counterpartyAccountId,
    destinationAddress: input.resolved.destinationAddress,
    ...(changedDestinationOrToken ? { destinationTokenAccount: null } : {}),
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    firstCollectionAt: input.resolved.firstCollectionAt,
    metadataUri: input.resolved.metadataUri,
    expectedStatus: "pending_activation",
    expectedUpdatedAt: input.recurringPayment.updated_at,
    updatedAt,
  });

  if (!updated) {
    throw new AppError(
      "CONFLICT",
      "Recurring payment changed while updating; retry with the latest payment"
    );
  }

  await recordRecurringPaymentUpdateEvent({
    recurringRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    attemptId: null,
    changedFields: input.resolved.changedFields.map(String),
    beforeValues: input.resolved.beforeValues,
    afterValues: input.resolved.afterValues,
    createdBy: input.createdBy,
    createdAt: updatedAt,
  });

  return updated;
}

async function getOrCreateRecurringPaymentUpdateAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  createdBy: string | null;
  nowIso: string;
  recoveringStaleUpdate: boolean;
}): Promise<PaymentRecurringPaymentUpdateAttemptRow> {
  if (input.recoveringStaleUpdate) {
    const existing = await input.recurringRepo.getLatestUpdateAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      statuses: ["processing"],
    });
    if (existing) {
      if (
        existing.mode !== input.mode ||
        !updateAttemptMatchesRequest(existing, {
          changedFields: input.changedFields,
          beforeValues: input.beforeValues,
          afterValues: input.afterValues,
        })
      ) {
        throw new AppError(
          "CONFLICT",
          "Recurring payment update recovery must retry the same update"
        );
      }
      return input.recurringRepo.updateUpdateAttempt({
        attemptId: existing.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        error: null,
        updatedAt: input.nowIso,
      });
    }
  }

  const attempt = await input.recurringRepo.createUpdateAttempt({
    id: `prpu_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    mode: input.mode,
    status: "processing",
    stage: "claim",
    oldPlanId: input.claimed.plan_id,
    oldSubscriptionId: input.claimed.subscription_id,
    newPlanId: null,
    newSubscriptionId: null,
    planUpdateSignature: null,
    planCreationSignature: null,
    authorizationSetupSignature: null,
    authorizationSignature: null,
    oldCancelSignature: null,
    changedFields: input.changedFields,
    beforeValues: input.beforeValues,
    afterValues: input.afterValues,
    error: null,
    createdBy: input.createdBy,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });

  if (!attempt) {
    await input.recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      expectedStatus: "updating",
      updatedAt: new Date().toISOString(),
    });
    throw new AppError("INTERNAL_ERROR", "Failed to journal recurring payment update");
  }

  return attempt;
}

function activeNextCollectionDueAt(input: {
  requested: string | null | undefined;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  onChainSubscription?: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  > | null;
  clampToMinimum?: boolean;
}): string | null | undefined {
  if (input.requested === undefined) {
    return undefined;
  }

  const periodHours = input.recurringPayment.period_hours;
  const onChainStartTs =
    input.onChainSubscription?.exists === true
      ? Number(input.onChainSubscription.data.currentPeriodStartTs)
      : NaN;
  const currentPeriodStartAt = Number.isFinite(onChainStartTs)
    ? new Date(onChainStartTs * 1000).toISOString()
    : (input.subscription?.current_period_start_at ??
      input.recurringPayment.next_collection_due_at);
  if (!currentPeriodStartAt) {
    throw new AppError("CONFLICT", "Recurring payment is missing active subscription timing");
  }

  const minimumDueAt = nextCollectionDueAt(currentPeriodStartAt, periodHours);
  const requested = input.requested ?? minimumDueAt;
  if (new Date(requested).getTime() < new Date(minimumDueAt).getTime()) {
    if (input.clampToMinimum) {
      return minimumDueAt;
    }
    throw badRequest("nextCollectionDueAt cannot be earlier than the next eligible collection");
  }

  return requested;
}

function replacementNextCollectionDueAt(input: {
  requested: string | null | undefined;
  periodStartAt: string;
  periodHours: number;
  clampToMinimum?: boolean;
}): string {
  const minimumDueAt = nextCollectionDueAt(input.periodStartAt, input.periodHours);
  const requested = input.requested ?? minimumDueAt;
  if (new Date(requested).getTime() < new Date(minimumDueAt).getTime()) {
    if (input.clampToMinimum) {
      return minimumDueAt;
    }
    throw badRequest(
      "nextCollectionDueAt cannot be earlier than the replacement subscription period"
    );
  }

  return requested;
}

async function finalizeMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  nextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    if (input.claimed.plan_id && input.resolved.metadataUri !== input.claimed.metadata_uri) {
      await subscriptionsRepo.updatePlan({
        planId: input.claimed.plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        metadataUri: input.resolved.metadataUri,
        updatedAt: finalizedAt,
      });
    }
    if (input.subscription && input.nextCollectionDueAt !== undefined) {
      await subscriptionsRepo.updateSubscription({
        subscriptionId: input.subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        nextCollectionDueAt: input.nextCollectionDueAt,
        expectedStatus: "active",
        updatedAt: finalizedAt,
      });
    }

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      metadataUri: input.resolved.metadataUri,
      ...(input.nextCollectionDueAt !== undefined
        ? { nextCollectionDueAt: input.nextCollectionDueAt }
        : {}),
      expectedStatus: "updating",
      updatedAt: finalizedAt,
    });
    if (!updated) {
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment update");
    }

    await recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: "finalize",
      error: null,
      updatedAt: finalizedAt,
    });
    const auditAfterValues =
      input.nextCollectionDueAt !== undefined &&
      input.resolved.changedFields.includes("nextCollectionDueAt")
        ? { ...input.resolved.afterValues, nextCollectionDueAt: input.nextCollectionDueAt }
        : input.resolved.afterValues;
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
      afterValues: auditAfterValues,
      createdBy: input.createdBy,
      createdAt: finalizedAt,
    });

    return updated;
  });
}

async function runMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const rpc = solanaRpc.createRpc(input.env);
  let attempt = input.attempt;
  let planUpdateSignature = attempt.plan_update_signature as Signature | null;

  let onChainSubscription: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  > | null = null;
  if (input.request.nextCollectionDueAt !== undefined && input.claimed.subscription_pda) {
    onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
      rpc,
      assertValidAddress(input.claimed.subscription_pda, "subscriptionPda") as Address,
      { commitment: "confirmed" }
    );
  }
  const nextDueAt = activeNextCollectionDueAt({
    requested: input.request.nextCollectionDueAt,
    recurringPayment: input.claimed,
    subscription: input.subscription,
    onChainSubscription,
    clampToMinimum: planUpdateSignature !== null,
  });

  if (input.resolved.metadataUri !== input.claimed.metadata_uri) {
    if (!input.claimed.plan_pda) {
      throw new AppError("CONFLICT", "Recurring payment is missing on-chain plan records");
    }

    const planPda = assertValidAddress(input.claimed.plan_pda, "planPda") as Address;
    const sourceSigner = await solanaServices.createOrgSigner(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.walletId
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    if (!planUpdateSignature) {
      const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
        commitment: "confirmed",
      });
      if (!onChainPlan.exists) {
        throw new AppError("TRANSACTION_FAILED", "Subscription plan was not found on-chain");
      }

      attempt = await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "update_plan",
        updatedAt: new Date().toISOString(),
      });
      const instruction = subscriptionsProgram.getUpdatePlanOverlayInstruction({
        endTs: onChainPlan.data.data.endTs,
        metadataUri: input.resolved.metadataUri ?? "",
        owner: sourceSigner,
        planPda,
        pullers: onChainPlan.data.data.pullers,
        status: onChainPlan.data.status as subscriptionsProgram.PlanStatus,
      });
      planUpdateSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [instruction],
      });
      attempt = await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planUpdateSignature,
        updatedAt: new Date().toISOString(),
      });
    }

    await confirmSubscriptionSignature(
      input.env,
      planUpdateSignature,
      "Recurring payment update failed on-chain"
    );
  }

  return finalizeMetadataScheduleUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    subscription: input.subscription,
    attempt,
    resolved: input.resolved,
    nextCollectionDueAt: nextDueAt,
    createdBy: input.createdBy,
  });
}

async function prepareSubscriptionAuthorityForUpdate(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  sourceWallet: CustodyWallet;
  sourceSigner: TransactionSigner;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthority: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionAuthority>
  >;
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  feePayer: Address;
}) {
  if (input.subscriptionAuthority.exists && input.sourceTokenAccount.exists) {
    return input.subscriptionAuthority;
  }

  const payer = createNoopSigner(input.feePayer);
  const initAuthorityInstruction = input.subscriptionAuthority.exists
    ? null
    : await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: input.sourceSigner,
        payer,
        tokenMint: input.mint,
        tokenProgram: input.tokenProgram,
        userAta: input.sourceTokenAccount.tokenAccount,
      });
  const createSourceAtaInstruction = input.sourceTokenAccount.exists
    ? null
    : getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: input.sourceTokenAccount.tokenAccount,
        owner: input.owner,
        mint: input.mint,
        tokenProgram: input.tokenProgram,
      });
  const initSignature = await sendSubscriptionInstructions({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [
      ...(createSourceAtaInstruction ? [createSourceAtaInstruction] : []),
      ...(initAuthorityInstruction ? [initAuthorityInstruction] : []),
    ],
    feePayer: input.feePayer,
  });
  await input.recurringRepo.updateUpdateAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    authorizationSetupSignature: initSignature,
    updatedAt: new Date().toISOString(),
  });
  await confirmSubscriptionSignature(input.env, initSignature);

  if (!initAuthorityInstruction) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  if (!subscriptionAuthority.exists) {
    throw new AppError("TRANSACTION_FAILED", "Subscription authority was not found on-chain");
  }
  return subscriptionAuthority;
}

async function getOrCreateReplacementPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentSubscriptionPlanRow> {
  if (input.attempt.new_plan_id) {
    const existing = await input.subscriptionsRepo.getPlanById({
      planId: input.attempt.new_plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const plan = await input.subscriptionsRepo.createPlan({
    id: `psp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerWalletId: input.sourceWallet.walletId,
    ownerAddress: input.sourceWallet.publicKey,
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    programPlanId: generateProgramPlanId(),
    planPda: null,
    destinationAddress: input.resolved.destinationAddress,
    pullerWalletId: input.sourceWallet.walletId,
    pullerAddress: input.sourceWallet.publicKey,
    metadataUri: input.resolved.metadataUri,
    status: "draft",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!plan) {
    throw new AppError("INTERNAL_ERROR", "Failed to create replacement subscription plan");
  }

  return plan;
}

async function getOrCreateReplacementSubscription(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  planId: string;
  resolved: ResolvedRecurringPaymentUpdate;
  createdBy: string | null;
}): Promise<PaymentSubscriptionRow> {
  if (input.attempt.new_subscription_id) {
    const existing = await input.subscriptionsRepo.getSubscriptionById({
      subscriptionId: input.attempt.new_subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const subscription = await input.subscriptionsRepo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.resolved.counterpartyId,
    subscriberAddress: input.resolved.sourceWallet.publicKey,
    subscriberTokenAccount: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_authorization",
    currentPeriodStartAt: null,
    nextCollectionDueAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!subscription) {
    throw new AppError("INTERNAL_ERROR", "Failed to create replacement subscription");
  }

  return subscription;
}

async function finalizeReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  oldSubscription: PaymentSubscriptionRow;
  plan: PaymentSubscriptionPlanRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  planPda: Address;
  planCreatedAt: string;
  planCreationSignature: Signature;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  authorizationSignature: Signature;
  oldCancelSignature: Signature;
  currentPeriodStartAt: string;
  nextCollectionDueAt: string;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await subscriptionsRepo.updateSubscription({
      subscriptionId: input.oldSubscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "canceled",
      cancelAt: finalizedAt,
      canceledAt: finalizedAt,
      updatedAt: finalizedAt,
    });
    if (input.claimed.plan_id) {
      await subscriptionsRepo.updatePlan({
        planId: input.claimed.plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "archived",
        updatedAt: finalizedAt,
      });
    }
    await subscriptionsRepo.updatePlan({
      planId: input.plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda: input.planPda,
      status: "active",
      updatedAt: finalizedAt,
    });
    await subscriptionsRepo.updateSubscription({
      subscriptionId: input.subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.authorizationSignature,
      status: "active",
      currentPeriodStartAt: input.currentPeriodStartAt,
      nextCollectionDueAt: input.nextCollectionDueAt,
      updatedAt: finalizedAt,
    });

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: input.resolved.sourceWallet.walletId,
      sourceAddress: input.resolved.sourceWallet.publicKey,
      counterpartyId: input.resolved.counterpartyId,
      counterpartyAccountId: input.resolved.counterpartyAccountId,
      destinationAddress: input.resolved.destinationAddress,
      destinationTokenAccount: null,
      token: input.resolved.token,
      amount: input.resolved.amount,
      periodHours: input.resolved.periodHours,
      firstCollectionAt: null,
      nextCollectionDueAt: input.nextCollectionDueAt,
      planId: input.plan.id,
      subscriptionId: input.subscription.id,
      planPda: input.planPda,
      planCreatedAt: input.planCreatedAt,
      planCreationSignature: input.planCreationSignature,
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.authorizationSignature,
      status: "active",
      metadataUri: input.resolved.metadataUri,
      expectedStatus: "updating",
      updatedAt: finalizedAt,
    });
    if (!updated) {
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment update");
    }

    await recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: "finalize",
      oldCancelSignature: input.oldCancelSignature,
      error: null,
      updatedAt: finalizedAt,
    });
    const auditChangedFields = input.resolved.changedFields.map(String);
    const auditBeforeValues = { ...input.resolved.beforeValues };
    const auditAfterValues = { ...input.resolved.afterValues };
    if (
      input.claimed.first_collection_at !== null &&
      !auditChangedFields.includes("firstCollectionAt")
    ) {
      auditChangedFields.push("firstCollectionAt");
      auditBeforeValues.firstCollectionAt = input.claimed.first_collection_at;
      auditAfterValues.firstCollectionAt = null;
    }
    if (
      input.claimed.next_collection_due_at !== input.nextCollectionDueAt &&
      !auditChangedFields.includes("nextCollectionDueAt")
    ) {
      auditChangedFields.push("nextCollectionDueAt");
      auditBeforeValues.nextCollectionDueAt = input.claimed.next_collection_due_at;
    }
    if (auditChangedFields.includes("nextCollectionDueAt")) {
      auditAfterValues.nextCollectionDueAt = input.nextCollectionDueAt;
    }
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: auditChangedFields,
      beforeValues: auditBeforeValues,
      afterValues: auditAfterValues,
      createdBy: input.createdBy,
      createdAt: finalizedAt,
    });

    return updated;
  });
}

async function runReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  oldSourceWallet: CustodyWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: ResolvedRecurringPaymentUpdate;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (
    !input.claimed.plan_pda ||
    !input.claimed.subscription_id ||
    !input.claimed.subscription_pda
  ) {
    throw new AppError("CONFLICT", "Recurring payment is missing on-chain subscription records");
  }
  const oldSubscription =
    input.subscription ??
    (await createPaymentSubscriptionsRepository(input.env).getSubscriptionById({
      subscriptionId: input.claimed.subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    }));
  if (!oldSubscription) {
    throw new AppError("NOT_FOUND", "Subscription not found");
  }

  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const rpc = solanaRpc.createRpc(input.env);
  let attempt = input.attempt;
  let planCreationSignature = attempt.plan_creation_signature as Signature | null;
  let authorizationSignature = attempt.authorization_signature as Signature | null;
  let oldCancelSignature = attempt.old_cancel_signature as Signature | null;
  const replacementPeriodStartAt = attempt.created_at;
  const requestedNextDue = replacementNextCollectionDueAt({
    requested: input.request.nextCollectionDueAt,
    periodStartAt: replacementPeriodStartAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: Boolean(planCreationSignature || authorizationSignature || oldCancelSignature),
  });

  const sourceSigner = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.resolved.sourceWallet.walletId
  );
  if (sourceSigner.address !== input.resolved.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }
  const owner = assertValidAddress(input.resolved.sourceWallet.publicKey, "sourceAddress");
  const destination = assertValidAddress(input.resolved.destinationAddress, "destinationAddress");
  const mint = assertValidAddress(input.resolved.token, "token") as Address;
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const sourceTokenAccount = await resolveSourceTokenAccountOrAta(rpc, owner, mint, tokenProgram);
  const amountBaseUnits = parseDecimalAmount(input.resolved.amount, sourceTokenAccount.decimals);
  if (amountBaseUnits <= 0n) {
    throw badRequest("Subscription amount must be greater than zero");
  }

  let plan = await getOrCreateReplacementPlan({
    subscriptionsRepo,
    attempt,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.resolved.sourceWallet,
    resolved: input.resolved,
    createdBy: input.createdBy,
  });
  if (attempt.new_plan_id !== plan.id) {
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      newPlanId: plan.id,
      updatedAt: new Date().toISOString(),
    });
  }

  const programPlanId = parseU64String(plan.program_plan_id, "programPlanId");
  const [planPda] = await subscriptionsProgram.findPlanPda({ owner, planId: programPlanId });
  plan =
    (await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      updatedAt: new Date().toISOString(),
    })) ?? plan;

  if (!planCreationSignature) {
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "create_plan",
      updatedAt: new Date().toISOString(),
    });
    const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
      amount: amountBaseUnits,
      destinations: [destination],
      endTs: 0n,
      metadataUri: input.resolved.metadataUri ?? "",
      mint,
      owner: sourceSigner,
      periodHours: BigInt(input.resolved.periodHours),
      planId: programPlanId,
      pullers: [owner],
      tokenProgram,
    });
    planCreationSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [createPlanInstruction],
    });
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planCreationSignature,
      updatedAt: new Date().toISOString(),
    });
  }

  await confirmSubscriptionSignature(
    input.env,
    planCreationSignature,
    "Recurring payment replacement plan creation failed on-chain"
  );
  const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
    commitment: "confirmed",
  });
  if (!onChainPlan.exists) {
    throw new AppError("TRANSACTION_FAILED", "Subscription plan was not found on-chain");
  }
  const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();

  let subscription = await getOrCreateReplacementSubscription({
    subscriptionsRepo,
    attempt,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: plan.id,
    resolved: input.resolved,
    createdBy: input.createdBy,
  });
  if (attempt.new_subscription_id !== subscription.id) {
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      newSubscriptionId: subscription.id,
      updatedAt: new Date().toISOString(),
    });
  }

  const [subscriptionAuthorityAddress] = await subscriptionsProgram.findSubscriptionAuthorityPda({
    tokenMint: mint,
    user: owner,
  });
  const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
    planPda,
    subscriber: owner,
  });
  subscription =
    (await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: sourceTokenAccount.tokenAccount,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: new Date().toISOString(),
    })) ?? subscription;

  if (!authorizationSignature) {
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "authorize_subscription",
      updatedAt: new Date().toISOString(),
    });
    let subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
      rpc,
      subscriptionAuthorityAddress,
      { commitment: "confirmed" }
    );
    const feePayer = await createFeePaymentAdapter(input.env).getFeePayer();
    const payer = createNoopSigner(feePayer);
    subscriptionAuthority = await prepareSubscriptionAuthorityForUpdate({
      env: input.env,
      recurringRepo,
      attempt,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rpc,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      sourceTokenAccount,
      subscriptionAuthority,
      subscriptionAuthorityAddress,
      owner,
      mint,
      tokenProgram,
      feePayer,
    });
    if (!subscriptionAuthority.exists) {
      throw new AppError("TRANSACTION_FAILED", "Subscription authority was not found on-chain");
    }

    const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
      expectedAmount: amountBaseUnits,
      expectedCreatedAt: BigInt(planCreatedAt),
      expectedPeriodHours: BigInt(input.resolved.periodHours),
      expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
      merchant: owner,
      payer,
      planId: programPlanId,
      subscriber: sourceSigner,
      tokenMint: mint,
    });
    authorizationSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      sourceSigner,
      instructions: [subscribeInstruction],
      feePayer,
    });
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      authorizationSignature,
      updatedAt: new Date().toISOString(),
    });
  }

  await confirmSubscriptionSignature(
    input.env,
    authorizationSignature,
    "Recurring payment replacement authorization failed on-chain"
  );

  if (!oldCancelSignature) {
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "cancel_old_subscription",
      updatedAt: new Date().toISOString(),
    });
    const oldSourceSigner = await solanaServices.createOrgSigner(
      input.env,
      input.organizationId,
      input.projectId,
      input.oldSourceWallet.walletId
    );
    if (oldSourceSigner.address !== input.oldSourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }
    const cancelInstruction =
      await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
        planPda: assertValidAddress(input.claimed.plan_pda, "planPda") as Address,
        subscriber: oldSourceSigner,
        subscriptionPda: assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
      });
    oldCancelSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.oldSourceWallet,
      sourceSigner: oldSourceSigner,
      instructions: [cancelInstruction],
    });
    attempt = await recurringRepo.updateUpdateAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      oldCancelSignature,
      updatedAt: new Date().toISOString(),
    });
  }

  await confirmSubscriptionSignature(
    input.env,
    oldCancelSignature,
    "Recurring payment old subscription cancellation failed on-chain"
  );

  const finalizedAt = new Date().toISOString();
  const safeNextDue = replacementNextCollectionDueAt({
    requested: requestedNextDue,
    periodStartAt: finalizedAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: true,
  });

  return finalizeReplacementUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    oldSubscription,
    plan,
    subscription,
    attempt,
    resolved: input.resolved,
    planPda,
    planCreatedAt,
    planCreationSignature,
    subscriptionPda,
    subscriptionAuthorityAddress,
    authorizationSignature,
    oldCancelSignature,
    currentPeriodStartAt: finalizedAt,
    nextCollectionDueAt: safeNextDue,
    createdBy: input.createdBy,
  });
}

async function recordRecurringPaymentUpdateFailure(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  error: unknown;
  resetToActive: boolean;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  await input.recurringRepo.updateUpdateAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: input.resetToActive ? "failed" : "processing",
    error: activationErrorMessage(input.error),
    updatedAt: failedAt,
  });

  if (input.resetToActive) {
    await input.recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      expectedStatus: "updating",
      updatedAt: failedAt,
    });
  }
}

export async function updateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  nextSourceWallet?: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  request: UpdatePaymentRecurringPaymentRequest;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  if (input.recurringPayment.source_wallet_id !== input.sourceWallet.walletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }
  if (input.recurringPayment.source_address !== input.sourceWallet.publicKey) {
    throw badRequest("Recurring payment source address does not match wallet");
  }

  const nowIso = new Date().toISOString();
  assertRecurringPaymentUpdateStatus(input.recurringPayment, nowIso);

  if (input.recurringPayment.status === "pending_activation") {
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
    });
  }

  if (input.request.firstCollectionAt !== undefined) {
    throw badRequest("firstCollectionAt can only be updated before activation");
  }

  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const paymentsRepo = createPaymentsRepository(input.env);
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

  const resolved = await resolveRecurringPaymentUpdate({
    ...input,
    recurringPayment: settled.recurringPayment,
  });
  if (resolved.changedFields.length === 0) {
    return settled.recurringPayment;
  }

  const mode = requestedActiveUpdateMode(resolved.changedFields);
  const recoveringStaleUpdate = settled.recurringPayment.status === "updating";
  const claimed = await recurringRepo.claimRecurringPaymentUpdate({
    recurringPaymentId: settled.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: new Date().toISOString(),
    staleBefore: updateStaleBefore(nowIso),
  });
  if (!claimed) {
    throw new AppError("CONFLICT", "Recurring payment update is already processing");
  }

  const attempt = await getOrCreateRecurringPaymentUpdateAttempt({
    recurringRepo,
    claimed,
    organizationId: input.organizationId,
    projectId: input.projectId,
    mode,
    changedFields: resolved.changedFields.map(String),
    beforeValues: resolved.beforeValues,
    afterValues: resolved.afterValues,
    createdBy: input.createdBy,
    nowIso,
    recoveringStaleUpdate,
  });

  try {
    if (mode === "metadata_schedule") {
      return await runMetadataScheduleUpdate({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        claimed,
        subscription: settled.subscription,
        attempt,
        resolved,
        request: input.request,
        createdBy: input.createdBy,
      });
    }

    return await runReplacementUpdate({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      oldSourceWallet: input.sourceWallet,
      claimed,
      subscription: settled.subscription,
      attempt,
      resolved,
      request: input.request,
      createdBy: input.createdBy,
    });
  } catch (error) {
    try {
      let currentAttempt = attempt;
      let resetToActive = false;
      try {
        const latest = await recurringRepo.getLatestUpdateAttempt({
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: claimed.id,
          statuses: ["processing"],
        });
        currentAttempt = latest ?? attempt;
        const hasReplacementAuthorization =
          currentAttempt.mode === "replacement" && Boolean(currentAttempt.authorization_signature);
        const hasSubmittedMetadataUpdate =
          currentAttempt.mode === "metadata_schedule" &&
          Boolean(currentAttempt.plan_update_signature);
        const transactionFailed = error instanceof AppError && error.code === "TRANSACTION_FAILED";
        resetToActive =
          !hasReplacementAuthorization && (!hasSubmittedMetadataUpdate || transactionFailed);
      } catch (latestAttemptError) {
        console.error("Failed to fetch latest recurring payment update attempt after failure", {
          error: activationErrorMessage(latestAttemptError),
          recurringPaymentId: claimed.id,
        });
      }

      await recordRecurringPaymentUpdateFailure({
        recurringRepo,
        attempt: currentAttempt,
        claimed,
        organizationId: input.organizationId,
        projectId: input.projectId,
        error,
        resetToActive,
      });
    } catch (journalError) {
      console.error("Failed to journal/reset recurring payment update after failure", {
        error: activationErrorMessage(journalError),
        recurringPaymentId: claimed.id,
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
  const tokenMint = assertRecurringPaymentTokenMint(input.token);
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
    token: tokenMint,
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
    token: tokenMint,
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

function assertActivationPreconditions(input: {
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
  if (input.recurringPayment.status === "active") {
    return;
  }
  if (input.recurringPayment.status === "activating") {
    if (isStaleActivation(input.recurringPayment, input.nowIso)) {
      return;
    }
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }
  if (input.recurringPayment.status !== "pending_activation") {
    throw new AppError("CONFLICT", "Recurring payment cannot be activated from this status");
  }
}

async function journalActivationClaimConflict(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  recurringPayment: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<void> {
  try {
    await input.recurringRepo.createActivationAttempt({
      id: `prpa_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      status: "failed",
      stage: "claim",
      planCreationSignature: input.recurringPayment.plan_creation_signature,
      authorizationSignature: input.recurringPayment.authorization_signature,
      error: "Recurring payment activation is already processing",
      metadata: {},
      createdAt: input.nowIso,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to journal recurring payment activation claim conflict", {
      error: error instanceof Error ? error.message : String(error),
      recurringPaymentId: input.recurringPayment.id,
    });
  }
}

async function createClaimedActivationAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
  recoveringStaleActivation: boolean;
}): Promise<PaymentRecurringPaymentActivationAttemptRow> {
  if (input.recoveringStaleActivation) {
    let existing: PaymentRecurringPaymentActivationAttemptRow | null = null;
    try {
      existing = await input.recurringRepo.getLatestActivationAttempt({
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        statuses: ["processing"],
      });
    } catch (error) {
      await resetRecurringPaymentActivationUnlessAlreadyActive({
        recurringRepo: input.recurringRepo,
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    if (existing) {
      try {
        const resumed = await input.recurringRepo.updateActivationAttempt({
          attemptId: existing.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          planCreationSignature:
            input.claimed.plan_creation_signature ?? existing.plan_creation_signature,
          authorizationSignature:
            input.claimed.authorization_signature ?? existing.authorization_signature,
          error: null,
          updatedAt: input.nowIso,
        });
        return resumed ?? existing;
      } catch (error) {
        await resetRecurringPaymentActivationUnlessAlreadyActive({
          recurringRepo: input.recurringRepo,
          recurringPaymentId: input.claimed.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
    }
  }

  let attempt: PaymentRecurringPaymentActivationAttemptRow | null = null;
  try {
    attempt = await input.recurringRepo.createActivationAttempt({
      id: `prpa_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      status: "processing",
      stage: "create_plan",
      planCreationSignature: input.claimed.plan_creation_signature,
      authorizationSignature: input.claimed.authorization_signature,
      error: null,
      metadata: {},
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    });
  } catch (error) {
    await resetRecurringPaymentActivationUnlessAlreadyActive({
      recurringRepo: input.recurringRepo,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }

  if (attempt) {
    return attempt;
  }

  await resetRecurringPaymentActivationUnlessAlreadyActive({
    recurringRepo: input.recurringRepo,
    recurringPaymentId: input.claimed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: new Date().toISOString(),
  });
  throw new AppError("INTERNAL_ERROR", "Failed to journal recurring payment activation");
}

async function settleActiveActivationAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  recurringPayment: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<void> {
  try {
    const attempt = await input.recurringRepo.getLatestActivationAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      statuses: ["processing"],
    });
    if (!attempt) {
      return;
    }

    await input.recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: "finalize",
      planCreationSignature:
        input.recurringPayment.plan_creation_signature ?? attempt.plan_creation_signature,
      authorizationSignature:
        input.recurringPayment.authorization_signature ?? attempt.authorization_signature,
      error: null,
      updatedAt: input.nowIso,
    });
  } catch (error) {
    console.error("Failed to settle recurring payment activation attempt on active replay", {
      error: error instanceof Error ? error.message : String(error),
      recurringPaymentId: input.recurringPayment.id,
    });
  }
}

async function fetchConfirmedActivationPlan(input: {
  env: Env;
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  planPda: Address;
  planCreationSignature: Signature;
  createdPlanThisRun: boolean;
}) {
  if (input.createdPlanThisRun) {
    await confirmSubscriptionSignature(input.env, input.planCreationSignature);
    return subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, {
      commitment: "confirmed",
    });
  }

  const existingPlan = await subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, {
    commitment: "confirmed",
  });
  if (existingPlan.exists) {
    return existingPlan;
  }

  await confirmSubscriptionSignature(input.env, input.planCreationSignature);
  return subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, {
    commitment: "confirmed",
  });
}

async function fetchConfirmedSubscriptionDelegation(input: {
  env: Env;
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  subscriptionPda: Address;
  authorizationSignature: Signature;
  authorizedThisRun: boolean;
}) {
  if (input.authorizedThisRun) {
    await confirmSubscriptionSignature(input.env, input.authorizationSignature);
    return subscriptionsProgram.fetchMaybeSubscriptionDelegation(input.rpc, input.subscriptionPda, {
      commitment: "confirmed",
    });
  }

  const existingSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
    input.rpc,
    input.subscriptionPda,
    { commitment: "confirmed" }
  );
  if (existingSubscription.exists) {
    return existingSubscription;
  }

  await confirmSubscriptionSignature(input.env, input.authorizationSignature);
  return subscriptionsProgram.fetchMaybeSubscriptionDelegation(input.rpc, input.subscriptionPda, {
    commitment: "confirmed",
  });
}

async function prepareSubscriptionAuthorityForActivation(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  organizationId: string;
  projectId: string;
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  sourceWallet: CustodyWallet;
  sourceSigner: TransactionSigner;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthority: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionAuthority>
  >;
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  feePayer: Address;
}) {
  if (input.subscriptionAuthority.exists && input.sourceTokenAccount.exists) {
    return input.subscriptionAuthority;
  }

  const payer = createNoopSigner(input.feePayer);
  const initAuthorityInstruction = input.subscriptionAuthority.exists
    ? null
    : await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: input.sourceSigner,
        payer,
        tokenMint: input.mint,
        tokenProgram: input.tokenProgram,
        userAta: input.sourceTokenAccount.tokenAccount,
      });
  const createSourceAtaInstruction = input.sourceTokenAccount.exists
    ? null
    : getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: input.sourceTokenAccount.tokenAccount,
        owner: input.owner,
        mint: input.mint,
        tokenProgram: input.tokenProgram,
      });
  const initSignature = await sendSubscriptionInstructions({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [
      ...(createSourceAtaInstruction ? [createSourceAtaInstruction] : []),
      ...(initAuthorityInstruction ? [initAuthorityInstruction] : []),
    ],
    feePayer: input.feePayer,
  });
  await input.recurringRepo.updateActivationAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    metadata: { authorizationSetupSignature: initSignature },
    updatedAt: new Date().toISOString(),
  });
  await confirmSubscriptionSignature(input.env, initSignature);

  if (!initAuthorityInstruction) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  if (!subscriptionAuthority.exists) {
    throw new AppError("TRANSACTION_FAILED", "Subscription authority was not found on-chain");
  }
  return subscriptionAuthority;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const rpc = solanaRpc.createRpc(input.env);
  const nowIso = new Date().toISOString();

  assertActivationPreconditions({ ...input, nowIso });
  if (input.recurringPayment.status === "active") {
    await settleActiveActivationAttempt({
      recurringRepo,
      recurringPayment: input.recurringPayment,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
    });
    return input.recurringPayment;
  }

  const recoveringStaleActivation = input.recurringPayment.status === "activating";
  const claimed = await recurringRepo.claimRecurringPaymentActivation({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: nowIso,
    staleBefore: activationStaleBefore(nowIso),
  });

  if (!claimed) {
    await journalActivationClaimConflict({
      recurringRepo,
      recurringPayment: input.recurringPayment,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
    });
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }

  const attempt = await createClaimedActivationAttempt({
    recurringRepo,
    claimed,
    organizationId: input.organizationId,
    projectId: input.projectId,
    nowIso,
    recoveringStaleActivation,
  });

  let currentStage: PaymentRecurringPaymentActivationAttemptStage = "create_plan";
  let planCreationSignature = (claimed.plan_creation_signature ??
    attempt.plan_creation_signature) as Signature | null;
  let authorizationSignature = (claimed.authorization_signature ??
    attempt.authorization_signature) as Signature | null;

  try {
    const owner = assertValidAddress(claimed.source_address, "sourceAddress") as Address;
    const destination = assertValidAddress(claimed.destination_address, "destinationAddress");
    const mint = assertValidAddress(claimed.token, "token") as Address;
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
    const sourceTokenAccount = await resolveSourceTokenAccountOrAta(rpc, owner, mint, tokenProgram);
    const amountBaseUnits = parseDecimalAmount(claimed.amount, sourceTokenAccount.decimals);

    if (amountBaseUnits <= 0n) {
      throw badRequest("Subscription amount must be greater than zero");
    }

    const plan = await getOrCreateActivationPlan({
      subscriptionsRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      destination,
      createdBy: input.createdBy,
    });

    const programPlanId = parseU64String(plan.program_plan_id, "programPlanId");
    const [planPda] = await subscriptionsProgram.findPlanPda({ owner, planId: programPlanId });
    const planUpdatedAt = new Date().toISOString();

    await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      updatedAt: planUpdatedAt,
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      planPda,
      updatedAt: planUpdatedAt,
    });

    await recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: currentStage,
      updatedAt: new Date().toISOString(),
    });
    let createdPlanThisRun = false;
    if (!planCreationSignature) {
      const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync(
        {
          amount: amountBaseUnits,
          destinations: [destination],
          endTs: 0n,
          metadataUri: claimed.metadata_uri ?? "",
          mint,
          owner: sourceSigner,
          periodHours: BigInt(claimed.period_hours),
          planId: programPlanId,
          pullers: [owner],
          tokenProgram,
        }
      );
      planCreationSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [createPlanInstruction],
      });
      const signatureUpdatedAt = new Date().toISOString();
      await recurringRepo.updateRecurringPaymentActivation({
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        updatedAt: signatureUpdatedAt,
      });
      await recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        updatedAt: signatureUpdatedAt,
      });
      createdPlanThisRun = true;
    }

    const onChainPlan = await fetchConfirmedActivationPlan({
      env: input.env,
      rpc,
      planPda,
      planCreationSignature,
      createdPlanThisRun,
    });
    if (!onChainPlan.exists) {
      throw new AppError("TRANSACTION_FAILED", "Subscription plan was not found on-chain");
    }
    const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();

    await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planCreatedAt,
      updatedAt: new Date().toISOString(),
    });

    const subscription = await getOrCreateActivationSubscription({
      subscriptionsRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      subscriberAddress: input.sourceWallet.publicKey,
      createdBy: input.createdBy,
    });

    currentStage = "authorize_subscription";
    const [subscriptionAuthorityAddress] = await subscriptionsProgram.findSubscriptionAuthorityPda({
      tokenMint: mint,
      user: owner,
    });
    const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
      planPda,
      subscriber: owner,
    });
    const authorizationUpdatedAt = new Date().toISOString();

    await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: sourceTokenAccount.tokenAccount,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: authorizationUpdatedAt,
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: subscription.id,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: authorizationUpdatedAt,
    });
    await recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: currentStage,
      updatedAt: authorizationUpdatedAt,
    });

    let authorizedThisRun = false;
    if (!authorizationSignature) {
      let subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
        rpc,
        subscriptionAuthorityAddress,
        { commitment: "confirmed" }
      );
      const feePayer = await createFeePaymentAdapter(input.env).getFeePayer();
      const payer = createNoopSigner(feePayer);

      subscriptionAuthority = await prepareSubscriptionAuthorityForActivation({
        env: input.env,
        recurringRepo,
        attempt,
        organizationId: input.organizationId,
        projectId: input.projectId,
        rpc,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        sourceTokenAccount,
        subscriptionAuthority,
        subscriptionAuthorityAddress,
        owner,
        mint,
        tokenProgram,
        feePayer,
      });
      if (!subscriptionAuthority.exists) {
        throw new AppError("TRANSACTION_FAILED", "Subscription authority was not found on-chain");
      }

      const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
        expectedAmount: amountBaseUnits,
        expectedCreatedAt: BigInt(planCreatedAt),
        expectedPeriodHours: BigInt(claimed.period_hours),
        expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
        merchant: owner,
        payer,
        planId: programPlanId,
        subscriber: sourceSigner,
        tokenMint: mint,
      });
      authorizationSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner,
        instructions: [subscribeInstruction],
        feePayer,
      });
      const signatureUpdatedAt = new Date().toISOString();
      await recurringRepo.updateRecurringPaymentActivation({
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        authorizationSignature,
        updatedAt: signatureUpdatedAt,
      });
      await recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        authorizationSignature,
        updatedAt: signatureUpdatedAt,
      });
      authorizedThisRun = true;
    }

    currentStage = "finalize";
    const onChainSubscription = await fetchConfirmedSubscriptionDelegation({
      env: input.env,
      rpc,
      subscriptionPda,
      authorizationSignature,
      authorizedThisRun,
    });
    if (!onChainSubscription.exists) {
      throw new AppError("TRANSACTION_FAILED", "Subscription authorization was not found on-chain");
    }

    const activatedAt = new Date().toISOString();
    const nextCollectionDueAt =
      claimed.first_collection_at ??
      new Date(
        new Date(activatedAt).getTime() + claimed.period_hours * 60 * 60 * 1000
      ).toISOString();

    await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      authorizationSignature,
      status: "active",
      currentPeriodStartAt: activatedAt,
      nextCollectionDueAt,
      updatedAt: activatedAt,
    });

    const finalized = await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      planId: plan.id,
      subscriptionId: subscription.id,
      planPda,
      planCreatedAt,
      planCreationSignature,
      subscriptionPda,
      subscriptionAuthorityAddress,
      authorizationSignature,
      nextCollectionDueAt,
      updatedAt: activatedAt,
    });

    if (!finalized) {
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment activation");
    }

    await recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: currentStage,
      planCreationSignature,
      authorizationSignature,
      error: null,
      updatedAt: activatedAt,
    });

    return finalized;
  } catch (error) {
    const failedAt = new Date().toISOString();
    try {
      await recordActivationFailure({
        recurringRepo,
        attempt,
        claimed,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        error,
        failedAt,
      });
    } catch (resetError) {
      console.error("Failed to journal/reset recurring payment activation after failure", {
        error: resetError instanceof Error ? resetError.message : String(resetError),
        recurringPaymentId: claimed.id,
      });
    }

    throw error;
  }
}

async function runRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  operation: PaymentRecurringPaymentLifecycleOperation;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const paymentsRepo = createPaymentsRepository(input.env);
  const nowIso = new Date().toISOString();

  assertLifecyclePreconditions({ ...input, nowIso });
  if (input.recurringPayment.status === lifecycleFinalStatus(input.operation)) {
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
  if (settled.recurringPayment.status === lifecycleFinalStatus(input.operation)) {
    return settled.recurringPayment;
  }

  const claimed = await recurringRepo.claimRecurringPaymentLifecycle({
    recurringPaymentId: settled.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    operation: input.operation,
    updatedAt: new Date().toISOString(),
    staleBefore: lifecycleStaleBefore(nowIso),
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
