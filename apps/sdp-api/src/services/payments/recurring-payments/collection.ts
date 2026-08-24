import {
  hasRecurringPaymentAdvancedPastDueAt,
  isRecurringPaymentCollectionActive,
  nextRecurringPaymentCollectionDueAt,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { getBase58Codec } from "@solana/codecs";
import { type Address, assertIsSignature, createNoopSigner, type Signature } from "@solana/kit";
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
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintDecimals,
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import {
  createTransferSignedSubmissionStore,
  isDefiniteSubmissionError,
  type TransferSignedSubmissionStore,
} from "@/services/payments/signed-submission";
import * as solanaServices from "@/services/solana";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { emitRecurringPaymentFailed } from "@/services/workflows/payment-events";
import type { Env } from "@/types/env";
import {
  DEFAULT_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
  parsePositiveIntegerConfig,
} from "../recurring-payment-config";
import { enforceRecurringPaymentPolicy } from "./policy";
import {
  activationErrorMessage,
  confirmSubscriptionSignature,
  sendSubscriptionInstructions,
} from "./shared";

const COLLECTION_STALE_AFTER_MS = RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS;
const base58 = getBase58Codec();

interface VerifiedRecurringPaymentCollection {
  attemptId: string;
  dueAt: string;
  destinationTokenAccount: Address;
  signature: Signature;
  transferId: string;
}

interface RecurringPaymentCollectionResult {
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}

function tenantScope(input: { organizationId: string; projectId: string }) {
  return createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
}

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

function validatedStoredCollectionSignature(input: {
  attemptId: string;
  signature: string;
  transferId: string;
}): Signature {
  try {
    assertIsSignature(input.signature);
    return input.signature;
  } catch (error) {
    getLogger().error(
      {
        attempt_id: input.attemptId,
        error: activationErrorMessage(error),
        transfer_id: input.transferId,
      },
      "Recurring payment collection stored signature is invalid"
    );
    throw new AppError(
      "INTERNAL_ERROR",
      "Recurring payment collection has an invalid stored signature"
    );
  }
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

function matchesRecurringTransferInstruction(input: {
  instruction: solanaRpc.ParsedInstruction;
  amountBaseUnits: bigint;
  sourceAddress: string;
  subscriberTokenAccount: string;
  subscriptionAuthorityAddress: string;
  subscriptionPda: string;
  planPda: string;
  destinationTokenAccount: string;
  token: string;
  tokenProgram: string;
  eventAuthority: string;
}): boolean {
  const { instruction } = input;
  if (
    instruction.programId !== subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS ||
    !instruction.accounts ||
    instruction.accounts.length !== 10 ||
    !instruction.data
  ) {
    return false;
  }

  let decoded: subscriptionsProgram.TransferSubscriptionInstructionData;
  try {
    decoded = subscriptionsProgram
      .getTransferSubscriptionInstructionDataDecoder()
      .decode(base58.encode(instruction.data));
  } catch {
    return false;
  }

  return (
    decoded.discriminator === subscriptionsProgram.TRANSFER_SUBSCRIPTION_DISCRIMINATOR &&
    decoded.transferData.amount === input.amountBaseUnits &&
    decoded.transferData.delegator === input.sourceAddress &&
    decoded.transferData.mint === input.token &&
    instruction.accounts[0] === input.subscriptionPda &&
    instruction.accounts[1] === input.planPda &&
    instruction.accounts[2] === input.subscriptionAuthorityAddress &&
    instruction.accounts[3] === input.subscriberTokenAccount &&
    instruction.accounts[4] === input.destinationTokenAccount &&
    instruction.accounts[5] === input.sourceAddress &&
    instruction.accounts[6] === input.token &&
    instruction.accounts[7] === input.tokenProgram &&
    instruction.accounts[8] === input.eventAuthority &&
    instruction.accounts[9] === subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS
  );
}

async function verifyRecurringPaymentCollection(input: {
  env: Env;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
  dueAt: string;
  destinationTokenAccount: Address;
}): Promise<VerifiedRecurringPaymentCollection> {
  const proofMismatch = (
    reason:
      | "persisted_evidence_mismatch"
      | "missing_verified_addresses"
      | "on_chain_instruction_mismatch",
    message: string
  ): AppError => {
    logEvent("error", {
      event: "sdp_api_recurring_payment_collection_proof_mismatch",
      reason,
      organization_id: input.transfer.organization_id,
      project_id: input.transfer.project_id,
      recurring_payment_id: input.recurringPayment.id,
      subscription_id: input.subscription.id,
      attempt_id: input.attempt.id,
      transfer_id: input.transfer.id,
      signature: input.signature,
    });
    return new AppError("CONFLICT", message);
  };
  const providerData = input.transfer.provider_data;
  const attemptMetadata = input.attempt.metadata;
  const providerEvidenceMatches =
    providerData.recurringPaymentId === input.recurringPayment.id &&
    ((providerData.subscriptionId === input.subscription.id &&
      providerData.collectionDueAt === input.dueAt) ||
      // Transfers created before settlement verification shipped only persisted the recurring ID.
      // Their exact attempt/transfer bindings and on-chain instruction are still verified below.
      (!Object.hasOwn(providerData, "subscriptionId") &&
        !Object.hasOwn(providerData, "collectionDueAt")));
  const persistedEvidenceMatches =
    input.attempt.subscription_id === input.subscription.id &&
    input.attempt.transfer_id === input.transfer.id &&
    input.attempt.due_at === input.dueAt &&
    input.attempt.token === input.recurringPayment.token &&
    input.attempt.amount === input.recurringPayment.amount &&
    attemptMetadata.recurringPaymentId === input.recurringPayment.id &&
    input.transfer.wallet_id === input.recurringPayment.source_wallet_id &&
    input.transfer.counterparty_id === input.recurringPayment.counterparty_id &&
    input.transfer.source_address === input.recurringPayment.source_address &&
    input.transfer.destination_address === input.recurringPayment.destination_address &&
    input.transfer.token === input.recurringPayment.token &&
    input.transfer.amount === input.recurringPayment.amount &&
    input.transfer.type === "transfer" &&
    input.transfer.direction === "outbound" &&
    providerEvidenceMatches &&
    (input.attempt.signature === null || input.attempt.signature === input.signature) &&
    input.transfer.signature === input.signature;

  if (!persistedEvidenceMatches) {
    throw proofMismatch(
      "persisted_evidence_mismatch",
      "Recurring payment collection evidence does not match the due payment"
    );
  }
  if (
    !input.recurringPayment.plan_pda ||
    !input.recurringPayment.subscription_pda ||
    !input.subscription.subscription_authority_address ||
    !input.subscription.subscriber_token_account
  ) {
    throw proofMismatch(
      "missing_verified_addresses",
      "Recurring payment collection is missing verified addresses"
    );
  }

  const planPda = input.recurringPayment.plan_pda;
  const subscriptionPda = input.recurringPayment.subscription_pda;
  const subscriptionAuthorityAddress = input.subscription.subscription_authority_address;
  const subscriberTokenAccount = input.subscription.subscriber_token_account;

  const rpc = solanaRpc.createRpc(input.env);
  const mint = assertValidAddress(input.recurringPayment.token, "token") as Address;
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const amountBaseUnits = parseDecimalAmount(
    input.recurringPayment.amount,
    await resolveMintDecimals(rpc, mint)
  );
  const confirmedTransaction = await solanaRpc.getTransaction(rpc, input.signature);
  if (!confirmedTransaction) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      "Recurring payment collection is confirmed but not yet indexed; retry shortly"
    );
  }
  if (confirmedTransaction.err) {
    throw new AppError("TRANSACTION_FAILED", "Recurring payment collection failed on-chain");
  }
  const [eventAuthority] = await subscriptionsProgram.findEventAuthorityPda();

  const hasExpectedInstruction = confirmedTransaction.instructions.some((instruction) =>
    matchesRecurringTransferInstruction({
      instruction,
      amountBaseUnits,
      sourceAddress: input.recurringPayment.source_address,
      subscriberTokenAccount,
      subscriptionAuthorityAddress,
      subscriptionPda,
      planPda,
      destinationTokenAccount: input.destinationTokenAccount,
      token: input.recurringPayment.token,
      tokenProgram,
      eventAuthority,
    })
  );
  if (!hasExpectedInstruction) {
    throw proofMismatch(
      "on_chain_instruction_mismatch",
      "Confirmed transaction does not prove the expected recurring payment collection"
    );
  }

  return {
    attemptId: input.attempt.id,
    dueAt: input.dueAt,
    destinationTokenAccount: input.destinationTokenAccount,
    signature: input.signature,
    transferId: input.transfer.id,
  };
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

        const currentSignature = currentTransfer.signature ?? input.submittedSignature;
        if (!currentSignature) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Confirmed collection transfer is missing signature"
          );
        }
        confirmedTransferSignature = validatedStoredCollectionSignature({
          attemptId: input.attempt.id,
          signature: currentSignature,
          transferId: input.transfer.id,
        });
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

  // Workflow trigger seam: a failed collection attempt fires recurring_payment_failed
  // (not token-scoped). Best-effort — never blocks the collection job.
  await emitRecurringPaymentFailed(input.env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    subscriptionId: input.attempt.subscription_id,
    dueAt: input.attempt.due_at,
    attemptId: input.attempt.id,
    error: message,
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
  proof: VerifiedRecurringPaymentCollection;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}> {
  const finalizedAt = new Date().toISOString();
  const dueAt = input.proof.dueAt;
  const nextDueAt = nextRecurringPaymentCollectionDueAt(dueAt, input.recurringPayment.period_hours);

  return getDb(input.env).transaction(async (tx) => {
    // Keep the externally submitted artifacts durable before advancing the due period.
    // Recovery can safely re-run this transaction because the period updates below are CAS-guarded.
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const paymentsRepo = createPostgresPaymentsRepository(
      tx,
      createTenantScope({
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    );

    const expectedTransferStatus = input.transfer.status;
    const updatedTransfer = await paymentsRepo.updateTransfer({
      transferId: input.transfer.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: expectedTransferStatus,
      status: expectedTransferStatus === "finalized" ? "finalized" : "confirmed",
      signature: input.proof.signature,
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
      signature: input.proof.signature,
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
      destinationTokenAccount: input.proof.destinationTokenAccount,
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
      finalizedAttempt.signature !== input.proof.signature ||
      finalizedAttempt.id !== input.proof.attemptId ||
      finalizedAttempt.transfer_id !== input.proof.transferId ||
      !finalizedTransfer ||
      (finalizedTransfer.status !== "confirmed" && finalizedTransfer.status !== "finalized") ||
      finalizedTransfer.signature !== input.proof.signature ||
      finalizedTransfer.id !== input.proof.transferId
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
  if (input.submittedSignature && !isDefiniteSubmissionError(input.error)) {
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
      getLogger().error(
        {
          attempt_id: input.attempt.id,
          attempt_journaled: attemptJournaled,
          attempt_journal_error:
            attemptResult.status === "rejected"
              ? activationErrorMessage(attemptResult.reason)
              : null,
          recurring_payment_id: input.recurringPaymentId,
          submitted_signature: input.submittedSignature,
          transfer_id: input.transfer.id,
          transfer_journaled: transferJournaled,
          transfer_journal_error:
            transferResult.status === "rejected"
              ? activationErrorMessage(transferResult.reason)
              : null,
        },
        "Partially journaled submitted recurring payment collection signature"
      );
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
    getLogger().error(
      {
        attempt_id: input.attempt.id,
        error: activationErrorMessage(journalError),
        has_submitted_signature: input.submittedSignature !== null,
        original_error: activationErrorMessage(input.error),
        recurring_payment_id: input.recurringPaymentId,
        transfer_id: input.transfer?.id ?? null,
      },
      "Failed to journal recurring payment collection after failure"
    );
  }
}

async function handleRecurringPaymentCollectionError(input: {
  env: Env;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  paymentsRepo: ReturnType<typeof createPaymentsRepository>;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  attempt: PaymentSubscriptionCollectionAttemptRow | null;
  transfer: PaymentTransferRow | null;
  submissionStore: TransferSignedSubmissionStore | null;
  submittedSignature: Signature | null;
  error: unknown;
}): Promise<RecurringPaymentCollectionResult> {
  if (!input.attempt) {
    throw input.error;
  }

  const submitted = await input.submissionStore?.submittedRow();
  if (submitted?.signature && !isDefiniteSubmissionError(input.error)) {
    const submittedSignature = validatedStoredCollectionSignature({
      attemptId: input.attempt.id,
      signature: submitted.signature,
      transferId: submitted.id,
    });
    await safeJournalRecurringPaymentCollectionError({
      env: input.env,
      subscriptionsRepo: input.subscriptionsRepo,
      paymentsRepo: input.paymentsRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attempt: input.attempt,
      transfer: submitted,
      submittedSignature,
      error: input.error,
    });
    if (input.error instanceof AppError && input.error.code === "CONFLICT") {
      throw input.error;
    }
    logEvent("warn", {
      event: "sdp_api_payment_submission_unresolved",
      flow: "recurring",
      reason: "submission_unconfirmed",
      organization_id: input.organizationId,
      project_id: input.projectId,
      recurring_payment_id: input.recurringPayment.id,
      attempt_id: input.attempt.id,
      transfer_id: submitted.id,
      transfer_type: submitted.type,
      signature: submittedSignature,
      error: activationErrorMessage(input.error),
    });
    return {
      recurringPayment: input.recurringPayment,
      collectionAttempt: { ...input.attempt, signature: submittedSignature },
      transfer: submitted,
    };
  }

  await safeJournalRecurringPaymentCollectionError({
    env: input.env,
    subscriptionsRepo: input.subscriptionsRepo,
    paymentsRepo: input.paymentsRepo,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    attempt: input.attempt,
    transfer: input.transfer,
    submittedSignature: input.submittedSignature,
    error: input.error,
  });
  throw input.error;
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
  if (existing.signature && transfer.signature && existing.signature !== transfer.signature) {
    logEvent("error", {
      event: "sdp_api_recurring_payment_collection_proof_mismatch",
      reason: "persisted_evidence_mismatch",
      mismatch: "attempt_transfer_signature",
      organization_id: input.organizationId,
      project_id: input.projectId,
      recurring_payment_id: input.recurringPayment.id,
      subscription_id: input.subscription.id,
      attempt_id: existing.id,
      transfer_id: transfer.id,
      attempt_signature: existing.signature,
      transfer_signature: transfer.signature,
    });
    throw new AppError("CONFLICT", "Recurring payment collection signatures do not match");
  }
  const storedSignature = existing.signature ?? transfer.signature;
  if (!storedSignature) {
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
  const recoveredSignature = validatedStoredCollectionSignature({
    attemptId: existing.id,
    signature: storedSignature,
    transferId: transfer.id,
  });
  if (
    transfer.status === "failed" &&
    transfer.signed_transaction !== null &&
    transfer.last_valid_block_height !== null &&
    transfer.submission_started_at === null
  ) {
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
      submittedSignature: recoveredSignature,
      error: new Error("Recurring payment collection was interrupted before broadcast"),
    });
    return null;
  }
  const recoveredAttempt =
    existing.signature === recoveredSignature
      ? existing
      : { ...existing, signature: recoveredSignature };
  const recoveredTransfer =
    transfer.signature === recoveredSignature
      ? transfer
      : { ...transfer, signature: recoveredSignature };

  try {
    await confirmSubscriptionSignature(
      input.env,
      recoveredSignature,
      "Recurring payment collection failed on-chain"
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "TRANSACTION_FAILED") {
      await markRecurringPaymentCollectionFailedAtomically({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        attempt: existing,
        transfer,
        submittedSignature: recoveredSignature,
        error,
      });
      return null;
    }
    // A recovered signature can age out of getSignatureStatuses' recent cache.
    // Continue to the exact transaction-evidence check below: an archival RPC can
    // still prove the completed collection without treating RPC uncertainty as failure.
  }

  try {
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
    const destinationTokenAccount = currentRecurringPayment.destination_token_account
      ? assertValidAddress(
          currentRecurringPayment.destination_token_account,
          "destinationTokenAccount"
        )
      : await resolveDestinationTokenAccount({
          env: input.env,
          destinationAddress: currentRecurringPayment.destination_address,
          token: currentRecurringPayment.token,
        });
    const proof = await verifyRecurringPaymentCollection({
      env: input.env,
      recurringPayment: currentRecurringPayment,
      subscription: currentSubscription,
      attempt: recoveredAttempt,
      transfer: recoveredTransfer,
      signature: recoveredSignature,
      dueAt: input.dueAt,
      destinationTokenAccount,
    });

    return finalizeRecurringPaymentCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: currentRecurringPayment,
      subscription: currentSubscription,
      attempt: recoveredAttempt,
      transfer: recoveredTransfer,
      proof,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "TRANSACTION_FAILED") {
      await markRecurringPaymentCollectionFailedAtomically({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        attempt: existing,
        transfer,
        submittedSignature: recoveredSignature,
        error,
      });
      return null;
    }
    await safeJournalRecurringPaymentCollectionError({
      env: input.env,
      subscriptionsRepo: input.subscriptionsRepo,
      paymentsRepo: input.paymentsRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attempt: existing,
      transfer,
      submittedSignature: recoveredSignature,
      error,
    });
    throw error;
  }
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
}): Promise<RecurringPaymentCollectionResult> {
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

  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env, tenantScope(input));
  const paymentsRepo = createPaymentsRepository(input.env, tenantScope(input));
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env, tenantScope(input));
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
  let submissionStore: TransferSignedSubmissionStore | null = null;
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

    await enforceRecurringPaymentPolicy({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      operationType: "recurring_payment_collection",
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      destination: input.recurringPayment.destination_address,
      apiKeyId: input.initiatedByKeyId,
      actor:
        input.initiatedByKeyId === null
          ? null
          : {
              type: "api_key",
              id: input.initiatedByKeyId,
              apiKeyId: input.initiatedByKeyId,
            },
      rawPayload: {
        recurringPaymentId: input.recurringPayment.id,
        subscriptionId: subscription.id,
        collectionDueAt: dueAt,
      },
    });

    const claimedAttempt = attempt;
    const linkedCollection = await getDb(input.env).transaction(async (tx) => {
      const transactionPaymentsRepo = createPostgresPaymentsRepository(tx, tenantScope(input));
      const transactionSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const createdTransfer = await transactionPaymentsRepo.createTransfer({
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
      if (!createdTransfer) {
        throw new AppError("INTERNAL_ERROR", "Failed to create collection transfer");
      }
      const linkedAttempt = await transactionSubscriptionsRepo.updateCollectionAttempt({
        attemptId: claimedAttempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        transferId: createdTransfer.id,
        status: "processing",
        updatedAt: new Date().toISOString(),
      });
      if (!linkedAttempt || linkedAttempt.transfer_id !== createdTransfer.id) {
        throw new AppError("INTERNAL_ERROR", "Failed to link collection attempt to transfer");
      }
      return { attempt: linkedAttempt, transfer: createdTransfer };
    });
    attempt = linkedCollection.attempt;
    transfer = linkedCollection.transfer;
    submissionStore = createTransferSignedSubmissionStore(paymentsRepo, transfer);

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
    const feePayment = await createProjectSponsorshipFeePayment(input.env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: input.sourceWallet.walletId },
    });
    const feePayer = await feePayment.getFeePayer();
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
      submissionStore,
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
    const proof = await verifyRecurringPaymentCollection({
      env: input.env,
      recurringPayment: recurringPaymentWithDestination,
      subscription,
      attempt,
      transfer,
      signature,
      dueAt,
      destinationTokenAccount: receiverAta,
    });

    return finalizeRecurringPaymentCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      subscription,
      attempt,
      transfer,
      proof,
    });
  } catch (error) {
    return handleRecurringPaymentCollectionError({
      env: input.env,
      subscriptionsRepo,
      paymentsRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      attempt,
      transfer,
      submissionStore,
      submittedSignature,
      error,
    });
  }
}
