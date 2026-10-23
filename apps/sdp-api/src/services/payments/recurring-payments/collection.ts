import {
  firstRecurringPaymentDueAfter,
  hasRecurringPaymentAdvancedPastDueAt,
  nextRecurringPaymentCollectionDueAt,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import {
  getTransaction,
  type ParsedInstruction,
  type ParsedTransaction,
  type SolanaRpc,
  tokenBalanceDelta,
} from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { AmountError } from "@sdp/solana/amount";
import { type MovementQuote, quoteMovement } from "@sdp/solana/movement-quote";
import {
  type BaseUnits,
  baseUnits,
  parseTokenAmount,
  toBaseUnits,
  toTokenAmount,
} from "@sdp/solana/token-amount";
import {
  type DestinationTokenAccount,
  recurringPullSupport,
  TOKEN_MOVEMENT_REFUSALS,
  TokenMovementError,
  type TokenMovementRefusal,
} from "@sdp/solana/token-movement";
import type { MintTokenTerms } from "@sdp/solana/token-terms";
import {
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  FAILED_COLLECTION_ATTEMPT_STATUSES,
  hasRecoverableRecurringPaymentCollection,
  isCollectableRecurringPaymentStatus,
  isSuccessfulPaymentTransferStatus,
  type PaymentSubscriptionCollectionAttemptInitialStatus,
  type PaymentSubscriptionCollectionAttemptMetadata,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
} from "@sdp/types/payments";
import { BUILT_MOVEMENT_VERDICTS } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  assertIsSignature,
  createNoopSigner,
  getBase58Encoder,
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
import { type DatabaseExecutor, getDb } from "@/db/client";
import type {
  CollectibleRecurringPaymentRow,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
  RecurringPaymentCollectionCycleRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type {
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
  PaymentSubscriptionsRepository,
} from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  generatePaymentTransferId,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import type { RecurringMandate } from "@/db/repositories/recurring-mandate";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import {
  createPostgresTokenMovementLegsRepository,
  type LegAmounts,
  ownWalletAmount,
} from "@/db/repositories/token-movement-legs.repository";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  solanaRpcError,
  transactionFailed,
} from "@/lib/errors";
import type { MoneyMovementRefusedError } from "@/lib/money-admission";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { createSigningService } from "@/services/domain/signing.service";
import type { TransferSignedSubmissionStore } from "@/services/payments/signed-submission";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
} from "@/services/sponsorship.service";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { mandateProgramAccounts, readRecurringTerms, rowMandate } from "./mandate";
import {
  assertRecurringPaymentSourceWallet,
  canonicalAttemptSignature,
  confirmSubscriptionSignature,
  readSavedSend,
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
  /**
   * What the landed pull moved (ADR 0012): the instruction's debit, and the
   * destination's raw token-balance delta as the credit; null when the
   * transaction shows no delta SDP can read.
   */
  observed: LegAmounts | null;
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
  /** Why the pull was held before it was signed; null for any other failure. */
  holdReason: TokenMovementRefusal | null;
}): PaymentSubscriptionCollectionAttemptMetadata {
  const metadata: PaymentSubscriptionCollectionAttemptMetadata = {
    source: "retry",
    recurringPaymentId: input.metadata.recurringPaymentId,
    initiatedByKeyId: input.metadata.initiatedByKeyId,
    initialSource: initialCollectionSource(input.metadata),
    transferId: input.transferId,
    error: input.error,
    retryAfterAt: input.retryAfterAt,
  };
  if (input.holdReason !== null) {
    metadata.holdReason = input.holdReason;
  }
  return metadata;
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
    // A definite refusal marks the attempt and its transfer failed in the caller.
    clearSigned: async () => {},
    submittedRow: async () => (submissionStarted ? row : null),
  };
}

/** The destination owner's associated token account under the mandate's mint and program. */
async function resolveDestinationTokenAccount(input: {
  destinationAddress: string;
  mandate: RecurringMandate;
}): Promise<Address> {
  const destinationOwner = assertValidAddress(input.destinationAddress, "destinationAddress");
  const { mint, tokenProgram } = mandateProgramAccounts(input.mandate);
  const [receiverAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram,
    mint,
  });
  return receiverAta;
}

/**
 * The trailing hook accounts of a pull, resolved the way the subscriptions
 * program orders them (its own `resolveTransferHookAccounts`: the hook
 * program, its validation account, then the extra accounts). The hook program
 * comes from the terms read for the pull: a mint without one needs no read,
 * and a pull whose resolution names another program is refused, since the
 * mint changed between the reads.
 *
 * RPC budget: none for a mint without a hook program; otherwise the SDK's
 * mint read, validation account read and one read per extra account whose
 * address comes from account data.
 */
async function recurringHookAccounts(
  rpc: SolanaRpc,
  terms: MintTokenTerms,
  transfer: { amount: BaseUnits; authority: Address; destination: Address; source: Address }
): Promise<subscriptionsProgram.TransferHookAccount[]> {
  if (terms.transferHookProgram === null) {
    return [];
  }
  const accounts = await subscriptionsProgram.resolveTransferHookAccounts(rpc, {
    ...transfer,
    mint: terms.asset.mint,
    tokenProgram: address(SPL_TOKEN_PROGRAMS[terms.asset.program]),
  });
  if (accounts[0]?.address !== terms.transferHookProgram) {
    throw new TokenMovementError(
      TOKEN_MOVEMENT_REFUSALS.hookUnresolved,
      "This token's transfer hook changed while the recurring payment collection was built; retry"
    );
  }
  return accounts;
}

/**
 * What a landed pull moved: the instruction's debit, and the destination
 * owner's raw token-balance delta of the mint as the credit
 * (`pre/postTokenBalances[].uiTokenAmount.amount`). The fee is the rest,
 * withheld in the destination.
 *
 * @returns The amounts, or null when the transaction shows no delta for the
 *   destination, or one that is not a credit of at most the debit.
 */
function observedPull(
  transaction: ParsedTransaction,
  pull: { debit: BaseUnits; mint: Address; destinationOwner: string }
): LegAmounts | null {
  const delta = tokenBalanceDelta(transaction, {
    mint: pull.mint,
    owner: pull.destinationOwner,
  });
  if (delta === null || delta.baseUnits < 0n || delta.baseUnits > pull.debit) {
    return null;
  }
  const credit = baseUnits(delta.baseUnits);
  return { debit: pull.debit, fee: baseUnits(pull.debit - credit), credit };
}

/** Whether a stored amount text is the mandate's debit, at the mandate's decimals. */
function isMandateDebit(amount: string | null, mandate: RecurringMandate): boolean {
  if (amount === null) {
    return false;
  }
  try {
    return toBaseUnits(parseTokenAmount(amount, mandate.decimals)) === mandate.debit;
  } catch (error) {
    if (error instanceof AmountError) {
      return false;
    }
    throw error;
  }
}

/**
 * Rebuilds a subscriptions-program instruction from the RPC's jsonParsed form so the SDK parser
 * can name its accounts. jsonParsed carries account addresses but not signer/writable roles, so
 * every account is given the read-only role; verification compares addresses and data only.
 *
 * @param parsed - One instruction from the confirmed transaction as returned by the RPC wrapper.
 * @returns The Kit instruction, or null when the instruction is not a subscriptions-program call
 *   with raw data.
 */
function subscriptionsInstructionFromRpc(parsed: ParsedInstruction): Instruction | null {
  if (
    parsed.programId !== subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS ||
    typeof parsed.data !== "string"
  ) {
    return null;
  }
  return {
    programAddress: subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
    accounts: parsed.accounts.map((account) => ({
      address: address(account),
      role: AccountRole.READONLY,
    })),
    data: getBase58Encoder().encode(parsed.data),
  };
}

/**
 * Whether a landed subscriptions-program instruction is the expected pull. A
 * pull with no trailing accounts matches only a mint with no hook at
 * execution (Token-2022 refuses a hooked transfer without them, and the pull
 * succeeded), so its hook accounts are resolved only when it carries some.
 */
async function matchesRecurringTransferInstruction(input: {
  rpc: SolanaRpc;
  instruction: Instruction;
  amountBaseUnits: BaseUnits;
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
    const trailingAccounts = instruction.accounts.slice(10);
    const transferHookAccounts =
      trailingAccounts.length === 0
        ? []
        : await subscriptionsProgram.resolveTransferHookAccounts(input.rpc, {
            amount: input.amountBaseUnits,
            authority: assertValidAddress(
              input.subscriptionAuthorityAddress,
              "subscriptionAuthority"
            ),
            destination: assertValidAddress(
              input.destinationTokenAccount,
              "destinationTokenAccount"
            ),
            mint: assertValidAddress(input.token, "token"),
            source: assertValidAddress(input.subscriberTokenAccount, "subscriberTokenAccount"),
            tokenProgram: assertValidAddress(input.tokenProgram, "tokenProgram"),
          });
    const hookAccountsMatch =
      trailingAccounts.length === transferHookAccounts.length &&
      transferHookAccounts.every((account, index) => {
        const trailingAccount = trailingAccounts[index];
        return trailingAccount !== undefined && trailingAccount.address === account.address;
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

/**
 * Proves a landed collection is the expected pull, and reads what it moved.
 *
 * RPC budget (before → now): the mint's owner read, `getTokenSupply`, one
 * `getTransaction` and the SDK's mint read for a Token-2022 mint → the one
 * `getTransaction`, whose token balances also give the observed credit; the
 * mandate's stored base units need no read. A pull that carried hook accounts
 * still resolves them to compare.
 */
async function verifyRecurringPaymentCollection(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
  dueAt: string;
  destinationTokenAccount: Address;
  mandate: RecurringMandate;
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
    isMandateDebit(input.attempt.amount, input.mandate) &&
    attemptMetadata.recurringPaymentId === input.recurringPayment.id &&
    (input.transfer.custody_wallet_id === null ||
      input.transfer.custody_wallet_id === input.recurringPayment.source_custody_wallet_id) &&
    input.transfer.wallet_id === input.recurringPayment.source_wallet_id &&
    input.transfer.counterparty_id === input.recurringPayment.counterparty_id &&
    input.transfer.source_address === input.recurringPayment.source_address &&
    input.transfer.destination_address === input.recurringPayment.destination_address &&
    input.transfer.token === input.recurringPayment.token &&
    isMandateDebit(input.transfer.amount, input.mandate) &&
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

  const rpc = createClusterRpc();
  const { mint, tokenProgram } = mandateProgramAccounts(input.mandate);
  const amountBaseUnits = input.mandate.debit;
  const confirmedTransaction = await getTransaction(rpc, input.signature);
  if (!confirmedTransaction) {
    throw solanaRpcError(
      "Recurring payment collection is confirmed but not yet indexed; retry shortly"
    );
  }
  if (confirmedTransaction.err !== null) {
    throw transactionFailed("Recurring payment collection failed on-chain");
  }
  const [eventAuthority] = await subscriptionsProgram.findEventAuthorityPda();

  let hasExpectedInstruction = false;
  for (const parsedInstruction of confirmedTransaction.instructions) {
    const instruction = subscriptionsInstructionFromRpc(parsedInstruction);
    if (instruction === null) continue;
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
    // The matched instruction's amount: the proof above requires it to be the mandate's debit.
    observed: observedPull(confirmedTransaction, {
      debit: amountBaseUnits,
      mint,
      destinationOwner: input.recurringPayment.destination_address,
    }),
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

/**
 * Locks a recurring payment's due collection cycle (`FOR UPDATE`) and confirms
 * no attempt already holds it. Collectors create their attempt under this lock
 * before they sign, so a cycle that is still open here cannot be signed by
 * anyone else until the transaction ends.
 */
async function lockOpenCollectionCycle(
  tx: DatabaseExecutor,
  input: {
    organizationId: string;
    projectId: string;
    recurringPayment: RecurringPaymentCollectionCycleRow;
    attemptedAt: string;
  }
): Promise<boolean> {
  const subscriptionId = input.recurringPayment.subscription_id;
  const dueAt = input.recurringPayment.next_collection_due_at;
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
  if (!locked) return false;

  const activeAttempt = await createPostgresPaymentSubscriptionsRepository(
    tx
  ).getCollectionAttemptByDue({
    organizationId: input.organizationId,
    projectId: input.projectId,
    subscriptionId,
    dueAt,
    statuses: COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  });
  return activeAttempt === null;
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
    if (!(await lockOpenCollectionCycle(tx, input))) return null;

    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    if (input.enforceCooldown && (await hasRecentCollectionFailure(subscriptionsRepo, input))) {
      return null;
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

async function hasRecentCollectionFailure(
  subscriptionsRepo: PaymentSubscriptionsRepository,
  input: {
    organizationId: string;
    projectId: string;
    recurringPayment: RecurringPaymentCollectionCycleRow;
    attemptedAt: string;
  }
): Promise<boolean> {
  const retryBefore = new Date(
    new Date(input.attemptedAt).getTime() -
      RECURRING_PAYMENT_COLLECTION_CONFIG.retryAfterMinutes * 60 * 1000
  ).toISOString();
  const recentFailure = await subscriptionsRepo.getCollectionAttemptByDue({
    organizationId: input.organizationId,
    projectId: input.projectId,
    subscriptionId: input.recurringPayment.subscription_id,
    dueAt: input.recurringPayment.next_collection_due_at,
    statuses: FAILED_COLLECTION_ATTEMPT_STATUSES,
  });
  return recentFailure !== null && recentFailure.updated_at > retryBefore;
}

/**
 * Claims a due period for a collection: under the lock collectors take before
 * they sign, one transaction writes the attempt (carrying the request's
 * Idempotency-Key, HOO-1918), the transfer it will submit, linked, and the
 * transfer's leg with the pull's quote (ADR 0012), verified from the chain
 * once the pull lands. Every keyed attempt therefore has a transfer, and a
 * same-key retry is answered from them. Returns null when the cycle moved on
 * or another attempt holds it.
 */
async function claimCollectionUnderRecurringLock(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  /** The pull's debit quote under the terms read before the claim. */
  quote: MovementQuote;
  attemptedAt: string;
  metadata: PaymentSubscriptionCollectionAttemptMetadata;
  enforceCooldown: boolean;
  initiatedByKeyId: string | null;
  idempotencyKey: string | null;
}): Promise<{
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
} | null> {
  const { recurringPayment } = input;
  return getDb(input.env).transaction(async (tx) => {
    if (!(await lockOpenCollectionCycle(tx, input))) return null;

    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    if (input.enforceCooldown && (await hasRecentCollectionFailure(subscriptionsRepo, input))) {
      return null;
    }
    const amount = ownWalletAmount(input.quote);
    const claimed = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: recurringPayment.subscription_id,
      transferId: null,
      token: recurringPayment.token,
      amount,
      dueAt: recurringPayment.next_collection_due_at,
      attemptedAt: input.attemptedAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: input.metadata,
      createdAt: input.attemptedAt,
      updatedAt: input.attemptedAt,
      idempotencyKey: input.idempotencyKey,
    });
    if (!claimed) return null;

    const paymentsRepo = createPostgresPaymentsRepository(tx, createTenantScope(input));
    const transfer = await paymentsRepo.createTransfer({
      id: generatePaymentTransferId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.sourceWallet.id,
      walletId: input.sourceWallet.walletId,
      counterpartyId: recurringPayment.counterparty_id,
      sourceAddress: input.sourceWallet.publicKey,
      destinationAddress: recurringPayment.destination_address,
      token: recurringPayment.token,
      amount,
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
        recurringPaymentId: recurringPayment.id,
        subscriptionId: recurringPayment.subscription_id,
        collectionDueAt: recurringPayment.next_collection_due_at,
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: input.initiatedByKeyId,
    });
    if (!transfer) {
      throw internalError("Failed to create collection transfer");
    }
    await createPostgresTokenMovementLegsRepository(tx, createTenantScope(input)).insertChainLeg({
      owner: { kind: "transfer", transferId: transfer.id },
      quote: input.quote,
    });
    const attempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      transferId: transfer.id,
      status: "processing",
      updatedAt: input.attemptedAt,
    });
    if (!attempt || attempt.transfer_id !== transfer.id) {
      throw internalError("Failed to link collection attempt to transfer");
    }
    return { attempt, transfer };
  });
}

/**
 * Skips a due collection period that money admission refused (HOO-1955): the
 * organization is deleted or suspended, or its production project lost the
 * entitlement. In one transaction, under the lock collectors take before they
 * sign, it records a `skipped` attempt (shown in the collection history with
 * the reason) and moves the due date to the first boundary after `now`. The
 * job stops selecting the row, and nothing is caught up after re-entitlement.
 *
 * Returns false and changes nothing when the cycle moved on or an attempt
 * already holds it; an in-flight collection finishes through recovery.
 */
export async function skipRefusedRecurringCollectionPeriod(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  refusal: MoneyMovementRefusedError;
  now: Date;
}): Promise<boolean> {
  const { recurringPayment } = input;
  const attemptedAt = input.now.toISOString();
  const dueAt = recurringPayment.next_collection_due_at;
  const nextDueAt = firstRecurringPaymentDueAfter(dueAt, recurringPayment.period_hours, input.now);

  return getDb(input.env).transaction(async (tx) => {
    if (!(await lockOpenCollectionCycle(tx, { ...input, attemptedAt }))) return false;

    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const skipped = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: recurringPayment.subscription_id,
      transferId: null,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
      dueAt,
      attemptedAt,
      status: "skipped",
      signature: null,
      error: input.refusal.message,
      metadata: initialCollectionMetadata({
        recurringPaymentId: recurringPayment.id,
        source: "automated",
        initiatedByKeyId: null,
      }),
      createdAt: attemptedAt,
      updatedAt: attemptedAt,
    });
    if (!skipped) {
      throw internalError("Failed to record the skipped recurring payment period");
    }

    const advanced = await createPostgresPaymentRecurringPaymentsRepository(
      tx
    ).updateRecurringPaymentCollection({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentCollectionDueAt: dueAt,
      nextCollectionDueAt: nextDueAt,
      updatedAt: attemptedAt,
    });
    if (!advanced) {
      throw conflict("Recurring payment changed while skipping a refused period");
    }
    const subscription = await subscriptionsRepo.updateSubscription({
      subscriptionId: recurringPayment.subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nextCollectionDueAt: nextDueAt,
      expectedNextCollectionDueAt: dueAt,
      expectedStatus: "active",
      updatedAt: attemptedAt,
    });
    if (!subscription) {
      throw conflict("Subscription changed while skipping a refused period");
    }
    return true;
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
      holdReason: null,
    }),
    enforceCooldown: true,
  });
}

/**
 * Records a pull held before it was signed (ADR 0012): a `failed` attempt
 * with its hold reason and retry time, under the lock collectors take, and no
 * transfer. The period stays due, and the next run past the retry time reads
 * the token's terms again. The cron honours the retry time as a cooldown; a
 * manual collect may ask again at once.
 */
async function journalHeldCollection(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  source: RecurringCollectionSource;
  initiatedByKeyId: string | null;
  hold: { refusal: TokenMovementRefusal; message: string };
}): Promise<void> {
  const attemptedAt = new Date().toISOString();
  const error = new Error(input.hold.message);
  await createCollectionAttemptUnderRecurringLock({
    ...input,
    attemptedAt,
    status: "failed",
    error: input.hold.message,
    metadata: retryCollectionMetadata({
      metadata: initialCollectionMetadata({
        recurringPaymentId: input.recurringPayment.id,
        source: input.source,
        initiatedByKeyId: input.initiatedByKeyId,
      }),
      transferId: null,
      error: input.hold.message,
      retryAfterAt: collectionRetryMetadata(error).retryAfterAt,
      holdReason: input.hold.refusal,
    }),
    enforceCooldown: input.source === "automated",
  });
}

/**
 * Settles the leg of a pull whose transfer the failure write just failed: it
 * moved nothing, so its leg needs no check against the chain. A transfer the
 * write did not fail (it confirmed meanwhile) keeps its leg pending.
 */
async function settleUnmovedPullLeg(
  tx: DatabaseExecutor,
  input: {
    organizationId: string;
    projectId: string;
    transferId: string;
    failed: boolean;
    failedAt: string;
  }
): Promise<void> {
  if (!input.failed) {
    return;
  }
  await createPostgresTokenMovementLegsRepository(
    tx,
    createTenantScope(input)
  ).settlePendingTransferLeg({
    transferId: input.transferId,
    verdict: BUILT_MOVEMENT_VERDICTS.failed,
    updatedAt: input.failedAt,
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
    holdReason: null,
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
      await settleUnmovedPullLeg(tx, {
        ...input,
        transferId: input.transfer.id,
        failed: transferRows > 0,
        failedAt,
      });
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
    const tenant = createTenantScope({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const paymentsRepo = createPostgresPaymentsRepository(tx, tenant);

    // The pull is a CPI the program made, so its leg is verified from what the landed
    // transaction moved, not by construction.
    const leg = await createPostgresTokenMovementLegsRepository(tx, tenant).recordChainVerdict({
      transferId: input.transfer.id,
      observed: input.proof.observed,
      updatedAt: finalizedAt,
    });
    if (leg !== null && leg.verification.state === "mismatch") {
      logEvent("error", {
        event: "sdp_api_recurring_payment_collection_amount_mismatch",
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: input.recurringPayment.id,
        transfer_id: input.transfer.id,
        signature: input.proof.signature,
        quoted_debit: leg.quoted.debit.toString(),
        quoted_credit: leg.quoted.credit.toString(),
        observed_credit: leg.observed === null ? null : leg.observed.credit.toString(),
      });
    }

    const expectedTransferStatus = input.transfer.status;
    const updatedTransfer = await paymentsRepo.updateTransfer({
      transferId: input.transfer.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: expectedTransferStatus,
      status: isSuccessfulPaymentTransferStatus(expectedTransferStatus)
        ? expectedTransferStatus
        : "confirmed",
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
      !isSuccessfulPaymentTransferStatus(finalizedTransfer.status) ||
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

/**
 * The mandate a pull is made under: the plan's, which is the one on chain,
 * else the payment's (a plan written before mandates has none); null when
 * neither row has one.
 */
function storedPullMandate(
  plan: Pick<PaymentSubscriptionPlanRow, "mandate"> | null,
  recurringPayment: Pick<PaymentRecurringPaymentRow, "mandate">
): RecurringMandate | null {
  if (plan !== null && plan.mandate !== null) {
    return plan.mandate;
  }
  return recurringPayment.mandate;
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
  /** A keyed collect request adopting the attempt records its key on it (HOO-1918). */
  idempotencyKey?: string | null;
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
  if (input.idempotencyKey) {
    // This request now answers for the period: a retry of it finds the attempt
    // instead of collecting the next one once the due date moves on. An attempt
    // another key already answers for is that request's (a null-key cron
    // attempt is adopted): recovering it here would leave this key free to pull
    // the next period, so it is refused as in flight, unstored.
    const adopted = await input.subscriptionsRepo.adoptCollectionAttemptIdempotencyKey({
      attemptId: existing.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!adopted) {
      throw conflict("Recurring payment collection is already processing");
    }
  }

  const failPull = async (message: string) => {
    await markRecurringPaymentCollectionFailedAtomically({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      attempt: existing,
      transfer,
      submittedSignature: recoveredSignature,
      error: transactionFailed(message),
    });
    return null;
  };
  const pullOutcome = await readSavedSend(createClusterRpc(), {
    signature: recoveredSignature,
    lastValidBlockHeight:
      transfer.last_valid_block_height === null ? null : BigInt(transfer.last_valid_block_height),
  });
  switch (pullOutcome) {
    case "succeeded":
      break;
    case "pending":
      throw conflict("Recurring payment collection is already processing");
    case "failed":
      return failPull("Recurring payment collection failed on-chain");
    case "expired":
      return failPull("Recurring payment collection expired without landing on-chain");
    default: {
      const exhaustive: never = pullOutcome;
      throw internalError(`Unknown collection pull outcome: ${exhaustive}`);
    }
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
    // The mandate the pull was made under needs no read: the plan's, or the
    // payment's. Only when neither row has one does recovery read the terms,
    // once, as the mint's owner and supply reads did before.
    const plan =
      currentRecurringPayment.plan_id === null
        ? null
        : await input.subscriptionsRepo.getPlanById({
            planId: currentRecurringPayment.plan_id,
            organizationId: input.organizationId,
            projectId: input.projectId,
          });
    const stored = storedPullMandate(plan, currentRecurringPayment);
    const mandate =
      stored === null
        ? rowMandate(
            currentRecurringPayment,
            (await readRecurringTerms(currentRecurringPayment.token, null, [])).terms
          )
        : stored;
    const destinationTokenAccount = currentRecurringPayment.destination_token_account
      ? assertValidAddress(
          currentRecurringPayment.destination_token_account,
          "destinationTokenAccount"
        )
      : await resolveDestinationTokenAccount({
          destinationAddress: currentRecurringPayment.destination_address,
          mandate,
        });
    const proof = await verifyRecurringPaymentCollection({
      recurringPayment: currentRecurringPayment,
      subscription: currentSubscription,
      attempt: recoveredAttempt,
      transfer: recoveredTransfer,
      signature: recoveredSignature,
      dueAt: input.dueAt,
      destinationTokenAccount,
      mandate,
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

/**
 * A pull held before it was signed: the token's terms refused it at this read
 * (ADR 0012). It answers 409 with the hold `reason`; it is no failure of SDP.
 */
class RecurringPullHeldError extends AppError {
  constructor(message: string, reason: TokenMovementRefusal) {
    super("CONFLICT", `Recurring payment collection is held: ${message}`, { reason });
    this.name = "RecurringPullHeldError";
  }
}

/** A pull SDP will make: its terms, the destination's account, the mandate and the quote. */
interface RecurringPull {
  terms: MintTokenTerms;
  destination: DestinationTokenAccount;
  mandate: RecurringMandate;
  quote: MovementQuote;
}

/**
 * Decides a due pull before anything is claimed (ADR 0012): one terms read,
 * with the destination's token account, then the recurring capability rule.
 * A paused mint, a fee above the mandate's tolerance, or a destination that
 * is frozen or requires memos holds the pull: a `failed` attempt with its hold reason and
 * retry time, no transfer, and the period still due. A cron run during a
 * failure's retry window reads nothing.
 *
 * RPC budget: one `getMultipleAccounts`.
 *
 * @throws AppError `CONFLICT` with the hold `reason` when the pull is held, or
 *   while the cron's retry window after a failure is open.
 */
async function decideRecurringPull(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: CollectibleRecurringPaymentRow;
  plan: PaymentSubscriptionPlanRow;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  source: RecurringCollectionSource;
  initiatedByKeyId: string | null;
  attemptedAt: string;
}): Promise<RecurringPull> {
  const { recurringPayment } = input;
  if (
    input.source === "automated" &&
    (await hasRecentCollectionFailure(input.subscriptionsRepo, input))
  ) {
    throw conflict("Recurring payment collection is already processing");
  }
  // For a payment written before mandates too, its amount at the decimals read now (`rowMandate`).
  const stored = storedPullMandate(input.plan, recurringPayment);
  let terms: MintTokenTerms;
  let destination: DestinationTokenAccount | undefined;
  let mandate: RecurringMandate;
  try {
    const read = await readRecurringTerms(recurringPayment.token, stored, [
      assertValidAddress(recurringPayment.destination_address, "destinationAddress"),
    ]);
    terms = read.terms;
    [destination] = read.destinations;
    mandate = rowMandate(
      { token: recurringPayment.token, amount: recurringPayment.amount, mandate: stored },
      terms
    );
  } catch (error) {
    if (error instanceof AppError && input.source === "automated") {
      await journalAutomatedCollectionFailure({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPayment,
        initiatedByKeyId: input.initiatedByKeyId,
        error,
      });
    }
    throw error;
  }
  if (destination === undefined) {
    throw internalError("The recurring terms read returned no destination token account");
  }
  const decision = recurringPullSupport(terms, mandate, destination);
  if (!decision.supported) {
    await journalHeldCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      source: input.source,
      initiatedByKeyId: input.initiatedByKeyId,
      hold: { refusal: decision.refusal, message: decision.message },
    });
    logEvent("warn", {
      event: "sdp_api_recurring_payment_collection_held",
      reason: decision.refusal,
      organization_id: input.organizationId,
      project_id: input.projectId,
      recurring_payment_id: recurringPayment.id,
      collection_source: input.source,
    });
    throw new RecurringPullHeldError(decision.message, decision.refusal);
  }
  const quote = quoteMovement(terms, {
    asset: terms.asset,
    amount: toTokenAmount(mandate.debit, mandate.decimals),
    basis: "debit",
  });
  return { terms, destination, mandate, quote };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  initiatedByKeyId: string | null;
  collectionSource: RecurringCollectionSource;
  /**
   * Money admission (HOO-1955), run once, after recovery and right before the
   * attempt that leads to a new signature. A refusal throws
   * `MoneyMovementRefusedError` with nothing written; finishing an in-flight
   * collection never asks.
   */
  admitStart: () => Promise<void>;
  /** The manual request's Idempotency-Key, written on the attempt it claims; null for the cron. */
  idempotencyKey: string | null;
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
    idempotencyKey: input.idempotencyKey,
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
  await input.admitStart();
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

    const pull = await decideRecurringPull({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      plan,
      subscriptionsRepo,
      source: input.collectionSource,
      initiatedByKeyId: input.initiatedByKeyId,
      attemptedAt: nowIso,
    });

    const linkedCollection = await claimCollectionUnderRecurringLock({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      recurringPayment,
      quote: pull.quote,
      attemptedAt: nowIso,
      metadata: initialCollectionMetadata({
        recurringPaymentId: input.recurringPayment.id,
        source: input.collectionSource,
        initiatedByKeyId: input.initiatedByKeyId,
      }),
      enforceCooldown: input.collectionSource === "automated",
      initiatedByKeyId: input.initiatedByKeyId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!linkedCollection) {
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
        idempotencyKey: input.idempotencyKey,
      });
      if (recoveredAfterConflict) {
        return recoveredAfterConflict;
      }
      throw conflict("Recurring payment collection is already processing");
    }

    attempt = linkedCollection.attempt;
    transfer = linkedCollection.transfer;
    submissionStore = createRecurringCollectionSignedSubmissionStore({
      env: input.env,
      attempt,
      transfer,
    });

    const rpc = createClusterRpc();
    const sourceOwner = assertValidAddress(input.recurringPayment.source_address, "sourceAddress");
    const destinationOwner = assertValidAddress(
      input.recurringPayment.destination_address,
      "destinationAddress"
    );
    const { mint, tokenProgram } = mandateProgramAccounts(pull.mandate);
    const sourceSigner = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id,
      "recurring.collect"
    );
    if (sourceSigner.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }

    // The stored mandate's base units, never the amount text parsed again (ADR 0012). RPC
    // budget (before → now): the mint's owner, the source token account and `getTokenSupply`
    // (and the SDK's mint read for a Token-2022 mint) → the one terms read before the claim,
    // which carried the destination's token account; the source account is derived.
    const amountBaseUnits = pull.mandate.debit;
    const receiverAta = pull.destination.tokenAccount;
    const [sourceTokenAccount] = await findAssociatedTokenPda({
      owner: sourceOwner,
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
    const transferHookAccounts = await recurringHookAccounts(rpc, pull.terms, {
      amount: amountBaseUnits,
      authority: subscriptionAuthority,
      destination: receiverAta,
      source: sourceTokenAccount,
    });
    const feePayment = createSponsorshipFeePayment(
      input.env,
      await resolveProjectSponsorshipScope(input.env, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        actor: { type: "wallet", id: input.sourceWallet.walletId },
      }),
      "recurring.collect",
      { custodyWalletId: input.sourceWallet.id }
    );
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
      movement: "recurring.collect",
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
      const txPaymentsRepo = createPostgresPaymentsRepository(
        tx,
        createTenantScope({ organizationId: input.organizationId, projectId: input.projectId })
      );
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

    await confirmSubscriptionSignature(signature, "Recurring payment collection failed on-chain");
    const proof = await verifyRecurringPaymentCollection({
      recurringPayment: recurringPaymentWithDestination,
      subscription,
      attempt,
      transfer,
      signature,
      dueAt,
      destinationTokenAccount: receiverAta,
      mandate: pull.mandate,
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
    // A held pull is logged where it is decided.
    if (!(error instanceof RecurringPullHeldError)) {
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
    }
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
