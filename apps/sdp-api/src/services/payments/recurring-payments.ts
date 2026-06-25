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
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
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

const U64_MAX = 18_446_744_073_709_551_615n;
const ACTIVATION_STALE_AFTER_MS = 15 * 60 * 1000;
const COLLECTION_STALE_AFTER_MS = 15 * 60 * 1000;

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

function isStaleActivation(row: PaymentRecurringPaymentRow, nowIso: string): boolean {
  return new Date(row.updated_at).getTime() <= new Date(activationStaleBefore(nowIso)).getTime();
}

function activationErrorMessage(error: unknown): string {
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

function collectionRetryMetadata(error: unknown): Record<string, unknown> {
  return {
    error: activationErrorMessage(error),
    retryAfterAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
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
  const metadata = {
    ...input.attempt.metadata,
    recurringPaymentId: input.recurringPaymentId,
    ...(input.transfer ? { transferId: input.transfer.id } : {}),
    ...collectionRetryMetadata(input.error),
  };

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
      ? {
          ...input.attempt.metadata,
          recurringPaymentId: input.recurringPaymentId,
          ...(input.transfer ? { transferId: input.transfer.id } : {}),
        }
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
      metadata: {
        ...input.attempt.metadata,
        recurringPaymentId: input.recurringPayment.id,
        transferId: input.transfer.id,
      },
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
}): Promise<PaymentRecurringPaymentActivationAttemptRow> {
  const attempt = await input.recurringRepo.createActivationAttempt({
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
    return input.recurringPayment;
  }

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
  });

  let currentStage: PaymentRecurringPaymentActivationAttemptStage = "create_plan";
  let planCreationSignature = claimed.plan_creation_signature as Signature | null;
  let authorizationSignature = claimed.authorization_signature as Signature | null;

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

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  initiatedByKeyId: string | null;
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
      metadata: { recurringPaymentId: input.recurringPayment.id },
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

    const transferCreatedAt = new Date().toISOString();
    transfer = await paymentsRepo.createTransfer({
      id: `xfr_${crypto.randomUUID()}`,
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
      initiatedByKeyId: input.initiatedByKeyId,
      createdAt: transferCreatedAt,
      updatedAt: transferCreatedAt,
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
