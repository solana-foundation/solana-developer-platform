import {
  hasRecurringPaymentAdvancedPastDueAt,
  nextRecurringPaymentCollectionDueAt,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  FAILED_COLLECTION_ATTEMPT_STATUSES,
  hasRecoverableRecurringPaymentCollection,
  isCollectableRecurringPaymentStatus,
  type PaymentSubscriptionCollectionAttemptInitialStatus,
  type PaymentSubscriptionCollectionAttemptMetadata,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
  recurringPaymentPolicyPayloadSchema,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types";
import {
  type Address,
  assertIsSignature,
  createNoopSigner,
  decompileTransactionMessageFetchingLookupTables,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  isInstructionForProgram,
  isInstructionWithAccounts,
  isInstructionWithData,
  type Signature,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import { getDb } from "@/db";
import {
  type CollectibleRecurringPaymentRow,
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
  type RecurringPaymentCollectionCycleRow,
} from "@/db/repositories";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  solanaRpcError,
  transactionFailed,
} from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintDecimals,
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { createSigningService } from "@/services/domain/signing.service";
import type { TransferSignedSubmissionStore } from "@/services/payments/signed-submission";
import * as solanaServices from "@/services/solana";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { enforceRecurringPaymentPolicy } from "./policy";
import {
  assertRecurringPaymentSourceWallet,
  canonicalAttemptSignature,
  confirmSubscriptionSignature,
  recurringPaymentErrorMessage,
  sendSubscriptionInstructions,
} from "./shared";

const COLLECTION_STALE_AFTER_MS = RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS;
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

type RecurringCollectionSource = "manual" | "automated";

function assertCollectibleRecurringPayment(
  row: PaymentRecurringPaymentRow
): asserts row is CollectibleRecurringPaymentRow {
  if (
    !isCollectableRecurringPaymentStatus(row.status) ||
    row.subscription_id === null ||
    row.next_collection_due_at === null
  ) {
    throw conflict("Recurring payment must be active before collection");
  }
}

function isStaleCollectionAttempt(row: PaymentSubscriptionCollectionAttemptRow): boolean {
  const updatedAt = new Date(row.updated_at).getTime();
  return Number.isFinite(updatedAt) && updatedAt <= Date.now() - COLLECTION_STALE_AFTER_MS;
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
    if (!(error instanceof Error)) throw error;
    getLogger().error(
      {
        attempt_id: input.attemptId,
        error: recurringPaymentErrorMessage(error),
        transfer_id: input.transferId,
      },
      "Recurring payment collection stored signature is invalid"
    );
    throw internalError("Recurring payment collection has an invalid stored signature");
  }
}

function recoverableCollectionSignature(input: {
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}): Signature | null {
  const signature = canonicalAttemptSignature({
    attemptSignature: input.attempt.signature,
    journalSignature: input.transfer.signature,
    label: "Recurring payment collection",
  });
  return signature === null
    ? null
    : validatedStoredCollectionSignature({
        attemptId: input.attempt.id,
        signature,
        transferId: input.transfer.id,
      });
}

function initialCollectionSource(
  metadata: PaymentSubscriptionCollectionAttemptMetadata
): RecurringCollectionSource {
  return metadata.source === "manual" || metadata.source === "automated"
    ? metadata.source
    : metadata.initialSource;
}

function initialCollectionMetadata(input: {
  recurringPaymentId: string;
  source: RecurringCollectionSource;
  initiatedByKeyId: string | null;
}): PaymentSubscriptionCollectionAttemptMetadata {
  return input.source === "manual"
    ? { ...input, source: "manual" }
    : { ...input, source: "automated" };
}

function retryCollectionMetadata(input: {
  metadata: PaymentSubscriptionCollectionAttemptMetadata;
  transferId: string | null;
  error: string;
  retryAfterAt: string;
}): PaymentSubscriptionCollectionAttemptMetadata {
  return {
    source: "retry",
    recurringPaymentId: input.metadata.recurringPaymentId,
    initiatedByKeyId: input.metadata.initiatedByKeyId,
    initialSource: initialCollectionSource(input.metadata),
    transferId: input.transferId,
    error: input.error,
    retryAfterAt: input.retryAfterAt,
  };
}

function linkedTransferCollectionMetadata(input: {
  metadata: PaymentSubscriptionCollectionAttemptMetadata;
  transferId: string;
}): PaymentSubscriptionCollectionAttemptMetadata {
  return {
    source: "linked_transfer",
    recurringPaymentId: input.metadata.recurringPaymentId,
    initiatedByKeyId: input.metadata.initiatedByKeyId,
    initialSource: initialCollectionSource(input.metadata),
    transferId: input.transferId,
  };
}

function createRecurringCollectionSignedSubmissionStore(input: {
  env: Env;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
}): TransferSignedSubmissionStore {
  let row: PaymentTransferRow | null = null;
  let submissionStarted = false;
  return {
    persistSigned: async ({ signature, signedTransaction, lastValidBlockHeight }) => {
      row = await getDb(input.env).transaction(async (tx) => {
        const paymentsRepo = createPostgresPaymentsRepository(
          tx,
          createTenantScope({
            organizationId: input.transfer.organization_id,
            projectId: input.transfer.project_id,
          })
        );
        const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
        const updatedTransfer = await paymentsRepo.persistSignedTransfer({
          transferId: input.transfer.id,
          organizationId: input.transfer.organization_id,
          projectId: input.transfer.project_id,
          signature,
          signedTransaction,
          lastValidBlockHeight,
          updatedAt: new Date().toISOString(),
        });
        if (updatedTransfer === null) {
          throw conflict("Recurring payment collection transfer changed concurrently");
        }
        const updatedAttempt = await subscriptionsRepo.updateCollectionAttempt({
          attemptId: input.attempt.id,
          organizationId: input.attempt.organization_id,
          projectId: input.attempt.project_id,
          transferId: input.transfer.id,
          signature,
          updatedAt: new Date().toISOString(),
        });
        if (updatedAttempt === null) {
          throw conflict("Recurring payment collection attempt changed concurrently");
        }
        return updatedTransfer;
      });
    },
    markStarted: async () => {
      const paymentsRepo = createPaymentsRepository(
        input.env,
        createTenantScope({
          organizationId: input.transfer.organization_id,
          projectId: input.transfer.project_id,
        })
      );
      const startedRow = await paymentsRepo.markTransferSubmissionStarted({
        transferId: input.transfer.id,
        organizationId: input.transfer.organization_id,
        projectId: input.transfer.project_id,
        startedAt: new Date().toISOString(),
      });
      if (startedRow === null) {
        throw conflict("Recurring payment collection transfer changed concurrently");
      }
      row = startedRow;
      submissionStarted = true;
    },
    hasStarted: async () => {
      const paymentsRepo = createPaymentsRepository(
        input.env,
        createTenantScope({
          organizationId: input.transfer.organization_id,
          projectId: input.transfer.project_id,
        })
      );
      const current = await paymentsRepo.getTransferById({
        transferId: input.transfer.id,
        organizationId: input.transfer.organization_id,
        projectId: input.transfer.project_id,
      });
      if (current !== null) row = current;
      submissionStarted = current?.submission_started_at !== null && current !== null;
      return submissionStarted;
    },
    submittedRow: async () => (submissionStarted ? row : null),
  };
}

async function resolveDestinationTokenAccount(input: {
  env: Env;
  destinationAddress: string;
  token: string;
}): Promise<Address> {
  const rpc = solanaRpc.createRpc(input.env);
  const destinationOwner = assertValidAddress(input.destinationAddress, "destinationAddress");
  const mint = assertValidAddress(input.token, "token");
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const [receiverAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram,
    mint,
  });
  return receiverAta;
}

async function matchesRecurringTransferInstruction(input: {
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  instruction: Instruction;
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
}): Promise<boolean> {
  const { instruction } = input;
  if (
    !isInstructionForProgram(instruction, subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS) ||
    !isInstructionWithAccounts(instruction) ||
    !isInstructionWithData(instruction) ||
    instruction.accounts.length < 10 ||
    subscriptionsProgram.identifySubscriptionsInstruction(instruction) !==
      subscriptionsProgram.SubscriptionsInstruction.TransferSubscription
  ) {
    return false;
  }

  try {
    const parsed = subscriptionsProgram.parseTransferSubscriptionInstruction(instruction);
    const transferHookAccounts = await subscriptionsProgram.resolveTransferHookAccounts(input.rpc, {
      amount: input.amountBaseUnits,
      authority: assertValidAddress(input.subscriptionAuthorityAddress, "subscriptionAuthority"),
      destination: assertValidAddress(input.destinationTokenAccount, "destinationTokenAccount"),
      mint: assertValidAddress(input.token, "token"),
      source: assertValidAddress(input.subscriberTokenAccount, "subscriberTokenAccount"),
      tokenProgram: assertValidAddress(input.tokenProgram, "tokenProgram"),
    });
    const trailingAccounts = instruction.accounts.slice(10);
    const hookAccountsMatch =
      trailingAccounts.length === transferHookAccounts.length &&
      transferHookAccounts.every((account, index) => {
        const trailingAccount = trailingAccounts[index];
        return (
          trailingAccount !== undefined &&
          trailingAccount.address === account.address &&
          trailingAccount.role === account.role
        );
      });
    return (
      parsed.data.transferData.amount === input.amountBaseUnits &&
      parsed.data.transferData.delegator === input.sourceAddress &&
      parsed.data.transferData.mint === input.token &&
      parsed.accounts.subscriptionPda.address === input.subscriptionPda &&
      parsed.accounts.planPda.address === input.planPda &&
      parsed.accounts.subscriptionAuthority.address === input.subscriptionAuthorityAddress &&
      parsed.accounts.delegatorAta.address === input.subscriberTokenAccount &&
      parsed.accounts.receiverAta.address === input.destinationTokenAccount &&
      parsed.accounts.caller.address === input.sourceAddress &&
      parsed.accounts.tokenMint.address === input.token &&
      parsed.accounts.tokenProgram.address === input.tokenProgram &&
      parsed.accounts.eventAuthority.address === input.eventAuthority &&
      parsed.accounts.selfProgram.address === subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS &&
      hookAccountsMatch
    );
  } catch {
    return false;
  }
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
    return conflict(message);
  };
  const providerData = input.transfer.provider_data;
  const attemptMetadata = input.attempt.metadata;
  const providerEvidenceMatches =
    providerData.recurringPaymentId === input.recurringPayment.id &&
    providerData.subscriptionId === input.subscription.id &&
    providerData.collectionDueAt === input.dueAt;
  const persistedEvidenceMatches =
    input.attempt.subscription_id === input.subscription.id &&
    input.attempt.transfer_id === input.transfer.id &&
    input.attempt.due_at === input.dueAt &&
    input.attempt.token === input.recurringPayment.token &&
    input.attempt.amount === input.recurringPayment.amount &&
    attemptMetadata.recurringPaymentId === input.recurringPayment.id &&
    (input.transfer.custody_wallet_id === null ||
      input.transfer.custody_wallet_id === input.recurringPayment.source_custody_wallet_id) &&
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
  const mint = assertValidAddress(input.recurringPayment.token, "token");
  const [tokenProgram, decimals] = await Promise.all([
    resolveMintTokenProgram(rpc, mint),
    resolveMintDecimals(rpc, mint),
  ]);
  const amountBaseUnits = parseDecimalAmount(input.recurringPayment.amount, decimals);
  const confirmedTransaction = await rpc
    .getTransaction(input.signature, {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!confirmedTransaction) {
    throw solanaRpcError(
      "Recurring payment collection is confirmed but not yet indexed; retry shortly"
    );
  }
  if (confirmedTransaction.meta?.err) {
    throw transactionFailed("Recurring payment collection failed on-chain");
  }
  const decodedTransaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(confirmedTransaction.transaction[0])
  );
  const transactionMessage = await decompileTransactionMessageFetchingLookupTables(
    getCompiledTransactionMessageDecoder().decode(decodedTransaction.messageBytes),
    rpc
  );
  const [eventAuthority] = await subscriptionsProgram.findEventAuthorityPda();

  let hasExpectedInstruction = false;
  for (const instruction of transactionMessage.instructions) {
    if (
      await matchesRecurringTransferInstruction({
        rpc,
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
    ) {
      hasExpectedInstruction = true;
      break;
    }
  }
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

function collectionRetryMetadata(error: Error): { error: string; retryAfterAt: string } {
  return {
    error: recurringPaymentErrorMessage(error),
    retryAfterAt: new Date(
      Date.now() + RECURRING_PAYMENT_COLLECTION_CONFIG.retryAfterMinutes * 60 * 1000
    ).toISOString(),
  };
}

async function createCollectionAttemptUnderRecurringLock(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  attemptedAt: string;
  status: PaymentSubscriptionCollectionAttemptInitialStatus;
  error: string | null;
  metadata: PaymentSubscriptionCollectionAttemptMetadata;
  enforceCooldown: boolean;
}): Promise<PaymentSubscriptionCollectionAttemptRow | null> {
  const subscriptionId = input.recurringPayment.subscription_id;
  const dueAt = input.recurringPayment.next_collection_due_at;

  return getDb(input.env).transaction(async (tx) => {
    const locked = await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = 'active'
            AND source_custody_wallet_id IS NOT DISTINCT FROM ?
            AND source_wallet_id = ?
            AND source_address = ?
            AND subscription_id = ?
            AND next_collection_due_at = ?
            AND next_collection_due_at <= ?
          FOR UPDATE`
      )
      .bind(
        input.recurringPayment.id,
        input.organizationId,
        input.projectId,
        input.recurringPayment.source_custody_wallet_id,
        input.recurringPayment.source_wallet_id,
        input.recurringPayment.source_address,
        subscriptionId,
        dueAt,
        input.attemptedAt
      )
      .first<{ id: string }>();
    if (!locked) return null;

    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const activeAttempt = await subscriptionsRepo.getCollectionAttemptByDue({
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId,
      dueAt,
      statuses: COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
    });
    if (activeAttempt) return null;

    if (input.enforceCooldown) {
      const retryBefore = new Date(
        new Date(input.attemptedAt).getTime() -
          RECURRING_PAYMENT_COLLECTION_CONFIG.retryAfterMinutes * 60 * 1000
      ).toISOString();
      const recentFailure = await subscriptionsRepo.getCollectionAttemptByDue({
        organizationId: input.organizationId,
        projectId: input.projectId,
        subscriptionId,
        dueAt,
        statuses: FAILED_COLLECTION_ATTEMPT_STATUSES,
      });
      if (recentFailure && recentFailure.updated_at > retryBefore) return null;
    }

    return subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId,
      transferId: null,
      token: input.recurringPayment.token,
      amount: input.recurringPayment.amount,
      dueAt,
      attemptedAt: input.attemptedAt,
      status: input.status,
      signature: null,
      error: input.error,
      metadata: input.metadata,
      createdAt: input.attemptedAt,
      updatedAt: input.attemptedAt,
    });
  });
}

export async function journalAutomatedCollectionFailure(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  initiatedByKeyId: string | null;
  error: Error;
}): Promise<void> {
  const attemptedAt = new Date().toISOString();
  const message = recurringPaymentErrorMessage(input.error);
  await createCollectionAttemptUnderRecurringLock({
    ...input,
    attemptedAt,
    status: "failed",
    error: message,
    metadata: retryCollectionMetadata({
      metadata: initialCollectionMetadata({
        recurringPaymentId: input.recurringPayment.id,
        source: "automated",
        initiatedByKeyId: input.initiatedByKeyId,
      }),
      transferId: null,
      ...collectionRetryMetadata(input.error),
    }),
    enforceCooldown: true,
  });
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
  error: Error;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  const message = recurringPaymentErrorMessage(input.error);
  const metadata = retryCollectionMetadata({
    metadata: input.attempt.metadata,
    transferId: input.transfer?.id ?? null,
    ...collectionRetryMetadata(input.error),
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

        if (currentTransfer === null || currentTransfer.status !== "confirmed") {
          throw internalError("Failed to mark collection transfer failed");
        }

        const currentSignature = currentTransfer.signature ?? input.submittedSignature;
        if (!currentSignature) {
          throw internalError("Confirmed collection transfer is missing signature");
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
    let attemptMetadata = metadata;
    if (confirmedTransferSignature !== null) {
      if (input.transfer === null) {
        throw internalError("Confirmed collection is missing its transfer");
      }
      attemptMetadata = linkedTransferCollectionMetadata({
        metadata: input.attempt.metadata,
        transferId: input.transfer.id,
      });
    }

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
      throw internalError("Failed to mark collection attempt failed");
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
    if (updatedTransfer === null) {
      throw conflict("Recurring payment transfer changed concurrently");
    }
    const finalizedTransfer = updatedTransfer;
    const updatedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      transferId: input.transfer.id,
      status: "confirmed",
      signature: input.proof.signature,
      error: null,
      metadata: linkedTransferCollectionMetadata({
        metadata: input.attempt.metadata,
        transferId: input.transfer.id,
      }),
      updatedAt: finalizedAt,
    });
    if (updatedAttempt === null) {
      throw conflict("Recurring payment collection attempt changed concurrently");
    }
    const finalizedAttempt = updatedAttempt;
    let finalizedSubscription = input.subscription;
    let finalizedRecurringPayment = input.recurringPayment;
    if (isCollectableRecurringPaymentStatus(input.recurringPayment.status)) {
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
      if (updatedSubscription === null) {
        throw conflict("Recurring payment subscription changed concurrently");
      }
      finalizedSubscription = updatedSubscription;
      const updatedRecurringPayment = await recurringRepo.updateRecurringPaymentCollection({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        currentCollectionDueAt: dueAt,
        nextCollectionDueAt: nextDueAt,
        destinationTokenAccount: input.proof.destinationTokenAccount,
        updatedAt: finalizedAt,
      });
      if (updatedRecurringPayment === null) {
        throw conflict("Recurring payment changed concurrently");
      }
      finalizedRecurringPayment = updatedRecurringPayment;
    }

    if (
      (isCollectableRecurringPaymentStatus(finalizedRecurringPayment.status) &&
        !hasRecurringPaymentAdvancedPastDueAt(
          finalizedRecurringPayment.next_collection_due_at,
          dueAt
        )) ||
      (finalizedSubscription.status === "active" &&
        isCollectableRecurringPaymentStatus(finalizedRecurringPayment.status) &&
        !hasRecurringPaymentAdvancedPastDueAt(
          finalizedSubscription.next_collection_due_at,
          dueAt
        )) ||
      finalizedAttempt.status !== "confirmed" ||
      finalizedAttempt.signature !== input.proof.signature ||
      finalizedAttempt.id !== input.proof.attemptId ||
      finalizedAttempt.transfer_id !== input.proof.transferId ||
      !SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.some((status) => status === finalizedTransfer.status) ||
      finalizedTransfer.signature !== input.proof.signature ||
      finalizedTransfer.id !== input.proof.transferId
    ) {
      throw internalError("Failed to finalize recurring payment collection");
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
  error: Error;
}): Promise<void> {
  if (input.submittedSignature && !isDefiniteSubmissionError(input.error)) {
    const updatedAt = new Date().toISOString();
    await getDb(input.env).transaction(async (tx) => {
      const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const paymentsRepo = createPostgresPaymentsRepository(
        tx,
        createTenantScope({
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      );
      const updatedAttempt = await subscriptionsRepo.updateCollectionAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...(input.transfer ? { transferId: input.transfer.id } : {}),
        signature: input.submittedSignature,
        updatedAt,
      });
      if (updatedAttempt?.signature !== input.submittedSignature) {
        throw conflict("Recurring payment collection attempt changed concurrently");
      }
      if (input.transfer) {
        const updatedTransfer = await paymentsRepo.updateTransfer({
          transferId: input.transfer.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          signature: input.submittedSignature,
          updatedAt,
        });
        if (updatedTransfer?.signature !== input.submittedSignature) {
          throw conflict("Recurring payment collection transfer changed concurrently");
        }
      }
    });
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
  error: Error;
}): Promise<void> {
  try {
    await journalRecurringPaymentCollectionError(input);
  } catch (journalError) {
    if (!(journalError instanceof Error)) throw journalError;
    getLogger().error(
      {
        attempt_id: input.attempt.id,
        error: recurringPaymentErrorMessage(journalError),
        has_submitted_signature: input.submittedSignature !== null,
        original_error: recurringPaymentErrorMessage(input.error),
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
  error: Error;
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
      error: recurringPaymentErrorMessage(input.error),
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
    statuses: COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  });
  if (!existing) {
    return null;
  }
  if (!existing.transfer_id) {
    if (!isStaleCollectionAttempt(existing)) {
      throw conflict("Recurring payment collection is already processing");
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
    throw internalError("Recurring payment collection transfer not found");
  }
  const recoveredSignature = recoverableCollectionSignature({ attempt: existing, transfer });
  if (recoveredSignature === null) {
    if (!isStaleCollectionAttempt(existing)) {
      throw conflict("Recurring payment collection is already processing");
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
  if (
    transfer.status === "failed" &&
    transfer.signed_transaction !== null &&
    transfer.last_valid_block_height !== null &&
    transfer.submission_started_at === null
  ) {
    if (!isStaleCollectionAttempt(existing)) {
      throw conflict("Recurring payment collection is already processing");
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
  const recoveredAttempt = existing;
  const recoveredTransfer = transfer;

  try {
    await confirmSubscriptionSignature(
      input.env,
      recoveredSignature,
      "Recurring payment collection failed on-chain"
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
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
  }

  try {
    const currentRecurringPayment =
      (await input.recurringRepo.getRecurringPaymentById({
        recurringPaymentId: input.recurringPayment.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        walletAuthorization: null,
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
    if (!(error instanceof Error)) throw error;
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
  collectionSource: RecurringCollectionSource;
}): Promise<RecurringPaymentCollectionResult> {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);
  if (!hasRecoverableRecurringPaymentCollection(input.recurringPayment.status)) {
    throw conflict("Recurring payment must be active before collection");
  }
  if (!input.recurringPayment.subscription_id || !input.recurringPayment.next_collection_due_at) {
    throw conflict("Recurring payment is missing subscription records");
  }
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const paymentsRepo = createPaymentsRepository(input.env, createTenantScope(input));
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscription = await subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.recurringPayment.subscription_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!subscription) {
    throw notFound("Subscription");
  }

  const dueAt = input.recurringPayment.next_collection_due_at;
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
  if (recovered) return recovered;
  if (!isCollectableRecurringPaymentStatus(input.recurringPayment.status)) {
    throw conflict("Recurring payment must be active before collection");
  }
  assertCollectibleRecurringPayment(input.recurringPayment);
  const recurringPayment = input.recurringPayment;
  if (!recurringPayment.plan_id) {
    throw conflict("Recurring payment is missing subscription records");
  }
  if (!recurringPayment.plan_pda || !recurringPayment.subscription_pda) {
    throw conflict("Recurring payment is missing on-chain subscription records");
  }
  const nowIso = new Date().toISOString();

  let attempt: PaymentSubscriptionCollectionAttemptRow | null = null;
  let transfer: PaymentTransferRow | null = null;
  let submittedSignature: Signature | null = null;
  let submissionStore: TransferSignedSubmissionStore | null = null;
  try {
    try {
      await createSigningService(input.env).admitRuntimeExecution(
        input.organizationId,
        input.projectId,
        input.sourceWallet.id
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (input.collectionSource === "automated") {
        await journalAutomatedCollectionFailure({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPayment: input.recurringPayment,
          initiatedByKeyId: input.initiatedByKeyId,
          error,
        });
      }
      throw error;
    }

    if (new Date(dueAt).getTime() > Date.now()) {
      throw badRequest("Recurring payment collection is not due yet");
    }

    const plan = await subscriptionsRepo.getPlanById({
      planId: recurringPayment.plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (!plan) {
      throw notFound("Subscription plan");
    }
    if (plan.status !== "active") {
      throw badRequest("Subscription plan must be active before collection");
    }
    if (subscription.status !== "active") {
      throw badRequest("Subscription must be active before collection");
    }

    attempt = await createCollectionAttemptUnderRecurringLock({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: input.recurringPayment,
      attemptedAt: nowIso,
      status: "processing",
      error: null,
      metadata: initialCollectionMetadata({
        recurringPaymentId: input.recurringPayment.id,
        source: input.collectionSource,
        initiatedByKeyId: input.initiatedByKeyId,
      }),
      enforceCooldown: input.collectionSource === "automated",
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
      throw conflict("Recurring payment collection is already processing");
    }

    await enforceRecurringPaymentPolicy({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
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
      rawPayload: recurringPaymentPolicyPayloadSchema.parse({
        operationType: "recurring_payment_collection",
        recurringPaymentId: input.recurringPayment.id,
        subscriptionId: subscription.id,
        collectionDueAt: dueAt,
      }),
    });

    const claimedAttempt = attempt;
    const linkedCollection = await getDb(input.env).transaction(async (tx) => {
      const transactionPaymentsRepo = createPostgresPaymentsRepository(
        tx,
        createTenantScope(input)
      );
      const transactionSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const createdTransfer = await transactionPaymentsRepo.createTransfer({
        id: generatePaymentTransferId(),
        organizationId: input.organizationId,
        projectId: input.projectId,
        custodyWalletId: input.sourceWallet.id,
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
        throw internalError("Failed to create collection transfer");
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
        throw internalError("Failed to link collection attempt to transfer");
      }
      return { attempt: linkedAttempt, transfer: createdTransfer };
    });
    attempt = linkedCollection.attempt;
    transfer = linkedCollection.transfer;
    submissionStore = createRecurringCollectionSignedSubmissionStore({
      env: input.env,
      attempt,
      transfer,
    });

    const rpc = solanaRpc.createRpc(input.env);
    const sourceOwner = assertValidAddress(input.recurringPayment.source_address, "sourceAddress");
    const destinationOwner = assertValidAddress(
      input.recurringPayment.destination_address,
      "destinationAddress"
    );
    const mint = assertValidAddress(input.recurringPayment.token, "token");
    const sourceSigner = await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
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
    const planPda = assertValidAddress(recurringPayment.plan_pda, "planPda");
    const subscriptionPda = assertValidAddress(
      recurringPayment.subscription_pda,
      "subscriptionPda"
    );
    const [subscriptionAuthority] = await subscriptionsProgram.findSubscriptionAuthorityPda({
      tokenMint: mint,
      user: sourceOwner,
    });
    const transferHookAccounts = await subscriptionsProgram.resolveTransferHookAccounts(rpc, {
      amount: amountBaseUnits,
      authority: subscriptionAuthority,
      destination: receiverAta,
      mint,
      source: sourceTokenAccount.tokenAccount,
      tokenProgram,
    });
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
        transferHookAccounts,
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
      throw conflict("Recurring payment is no longer active");
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
    const attemptId = attempt.id;
    const transferId = transfer.id;
    const submitted = await getDb(input.env).transaction(async (tx) => {
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const txPaymentsRepo = createPostgresPaymentsRepository(tx);
      const updatedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
        attemptId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature,
        status: "processing",
        error: null,
        updatedAt: submittedAt,
      });
      if (!updatedAttempt) {
        throw internalError("Failed to update collection attempt");
      }
      const updatedTransfer = await txPaymentsRepo.updateTransfer({
        transferId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature,
        error: null,
        updatedAt: submittedAt,
      });
      if (!updatedTransfer) {
        throw internalError("Failed to update collection transfer");
      }
      return { attempt: updatedAttempt, transfer: updatedTransfer };
    });
    attempt = submitted.attempt;
    transfer = submitted.transfer;

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
    if (!(error instanceof Error)) throw error;
    getLogger().error(
      {
        err: error,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: input.recurringPayment.id,
        attempt_id: attempt?.id ?? null,
        transfer_id: transfer?.id ?? null,
      },
      "Recurring payment collection failed"
    );
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
