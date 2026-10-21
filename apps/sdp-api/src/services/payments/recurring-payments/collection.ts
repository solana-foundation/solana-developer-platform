import {
  firstRecurringPaymentDueAfter,
  hasRecurringPaymentAdvancedPastDueAt,
  nextRecurringPaymentCollectionDueAt,
  RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getTransaction, type ParsedInstruction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  assertNever,
  COLLECTABLE_RECURRING_PAYMENT_STATUSES,
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE,
  COLLECTION_ATTEMPT_STATUSES_FAILABLE,
  COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER,
  FAILED_COLLECTION_ATTEMPT_STATUSES,
  hasRecoverableRecurringPaymentCollection,
  isCollectableRecurringPaymentStatus,
  isSuccessfulPaymentTransferStatus,
  type PaymentSubscriptionCollectionAttemptInitialStatus,
  type PaymentSubscriptionCollectionAttemptMetadata,
  type PaymentSubscriptionCollectionAttemptStatus,
  type PaymentTransferStatus,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
} from "@sdp/types/payments";
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
  isSolanaError,
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
  CollectionAttemptDelegationPreImage,
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionRow,
  PaymentSubscriptionsRepository,
} from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  generatePaymentTransferId,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
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
import { type MintFacts, readMintFacts } from "@/services/mint-facts";
import type { TransferSignedSubmissionStore } from "@/services/payments/signed-submission";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  assertRecurringPaymentSourceWallet,
  canonicalAttemptSignature,
  collectionPulledEffect,
  confirmSubscriptionSignature,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepRead,
  ResumedStepUnsettledError,
  readConfirmedAccounts,
  readRecurringPaymentStep,
  recurringPaymentErrorMessage,
  resolveRecurringPaymentSponsor,
  sendSubscriptionInstructions,
} from "./shared";

const COLLECTION_STALE_AFTER_MS = RECURRING_PAYMENT_OPERATION_STALE_AFTER_MS;
interface VerifiedRecurringPaymentCollection {
  attemptId: string;
  dueAt: string;
  destinationTokenAccount: Address;
  signature: Signature;
  /** The slot the confirmed pull landed in; the next pull's pre-image read must reach it. */
  slot: bigint;
  transferId: string;
}

/**
 * What the chain shows of a collection's signature: not indexed yet, failed on chain, without the
 * expected pull, or proving it.
 */
type RecurringPaymentCollectionVerification =
  | { kind: "not_indexed" }
  | { kind: "failed_on_chain" }
  | { kind: "instruction_mismatch" }
  | { kind: "proven"; proof: VerifiedRecurringPaymentCollection };

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

/**
 * The submission store a collection pull sends with. `persistSigned` saves the signature, signed
 * bytes and expiry on the transfer, and the signature and the delegation's pre-image on the
 * attempt, in one transaction; the pre-image is written only while the attempt has none.
 *
 * @param input - The collection's rows and the delegation's pre-image.
 * @param input.env - The API environment.
 * @param input.attempt - The claimed collection attempt.
 * @param input.transfer - The attempt's transfer.
 * @param input.delegationPreImage - The delegation's period start and amount pulled, read before signing.
 * @returns The store.
 */
function createRecurringCollectionSignedSubmissionStore(input: {
  env: Env;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  delegationPreImage: CollectionAttemptDelegationPreImage;
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
          delegationPreImage: input.delegationPreImage,
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

/**
 * Reads the subscription delegation's period start and amount pulled at `confirmed` before a pull
 * is claimed and signed: the pre-image recovery proves the pull against. The answering bank must
 * reach the cluster's confirmed slot and the slot the subscription's last proven pull landed in,
 * so a node behind that pull cannot hand back a pre-image a later dropped pull would read as
 * landed. A read that fails writes nothing, so the cron retries it next tick without a cooldown;
 * an RPC refusal (every endpoint below the floor, say) answers as an RPC error.
 *
 * @param input - The subscription to read.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.organizationId - The subscription's organization.
 * @param input.projectId - The subscription's project.
 * @param input.subscriptionId - The subscription whose last proven pull sets the slot floor.
 * @param input.subscriptionPda - The delegation the pull draws on.
 * @returns The delegation's pre-image.
 * @throws AppError SOLANA_RPC_ERROR when the RPC refuses the read or answers from a bank below
 *   the floor.
 * @throws AppError CONFLICT when the delegation is not on chain.
 */
async function readCollectionDelegationPreImage(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  organizationId: string;
  projectId: string;
  subscriptionId: string;
  subscriptionPda: Address;
}): Promise<CollectionAttemptDelegationPreImage> {
  const minContextSlot = await input.subscriptionsRepo.getLastConfirmedCollectionSlot(input);
  let read: Awaited<ReturnType<typeof readConfirmedAccounts>>;
  try {
    read = await readConfirmedAccounts({ addresses: [input.subscriptionPda], minContextSlot });
  } catch (error) {
    if (isSolanaError(error)) {
      throw solanaRpcError("Recurring payment subscription delegation could not be read; retry");
    }
    throw error;
  }
  const [delegationAccount] = read.accounts;
  if (!delegationAccount.exists) {
    throw conflict("Recurring payment subscription delegation is not on chain");
  }
  const delegation = subscriptionsProgram.decodeSubscriptionDelegation(delegationAccount).data;
  return {
    periodStartTs: delegation.currentPeriodStartTs,
    amountPulled: delegation.amountPulledInPeriod,
  };
}

async function resolveDestinationTokenAccount(input: {
  destinationAddress: string;
  token: string;
}): Promise<Address> {
  const destinationOwner = assertValidAddress(input.destinationAddress, "destinationAddress");
  const mint = assertValidAddress(input.token, "token");
  const { tokenProgram } = await readMintFacts(mint);
  const [receiverAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram,
    mint,
  });
  return receiverAta;
}

/**
 * The extra accounts a pull of the mint carries for its transfer hook, read live, since the hook
 * authority can change them; none for a mint without the extension, which reads nothing. The SDK
 * resolver reads the mint again for any Token-2022 mint, so it is called only for a hook.
 *
 * @param input - The pull's mint and accounts.
 * @param input.mintFacts - The mint's facts, which say whether it has a hook.
 * @param input.mint - The mint.
 * @param input.amount - The pull's amount, in base units.
 * @param input.authority - The source wallet's subscription authority, which signs the transfer.
 * @param input.source - The token account the pull debits.
 * @param input.destination - The token account the pull pays.
 * @returns The hook's accounts, in the order the pull appends them.
 */
async function resolveCollectionTransferHookAccounts(input: {
  mintFacts: MintFacts;
  mint: Address;
  amount: bigint;
  authority: Address;
  source: Address;
  destination: Address;
}): Promise<subscriptionsProgram.TransferHookAccount[]> {
  if (!input.mintFacts.hasTransferHook) {
    return [];
  }
  return subscriptionsProgram.resolveTransferHookAccounts(createClusterRpc(), {
    amount: input.amount,
    authority: input.authority,
    destination: input.destination,
    mint: input.mint,
    source: input.source,
    tokenProgram: input.mintFacts.tokenProgram,
  });
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

async function matchesRecurringTransferInstruction(input: {
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
  transferHookAccounts: readonly subscriptionsProgram.TransferHookAccount[];
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
    const hookAccountsMatch =
      trailingAccounts.length === input.transferHookAccounts.length &&
      input.transferHookAccounts.every((account, index) => {
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
 * Verifies a collection's confirmed transaction against the due payment's stored evidence: the
 * attempt, transfer and schedule agree, and the transaction carries the expected pull.
 *
 * @param input - The collection to verify.
 * @param input.recurringPayment - The schedule as it stands now.
 * @param input.subscription - The schedule's subscription as it stands now.
 * @param input.attempt - The collection attempt.
 * @param input.transfer - The attempt's transfer.
 * @param input.signature - The pull's signature.
 * @param input.dueAt - The period the pull collects.
 * @param input.destinationTokenAccount - The token account the pull pays.
 * @param input.sentTransferHookAccounts - The hook accounts the send just built into the pull, or
 *   null for a recovery, which resolves them again once the transaction is found.
 * @returns What the chain shows of the signature; an instruction mismatch is logged.
 * @throws AppError CONFLICT when the stored evidence does not match the due payment.
 */
async function verifyRecurringPaymentCollection(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
  dueAt: string;
  destinationTokenAccount: Address;
  sentTransferHookAccounts: subscriptionsProgram.TransferHookAccount[] | null;
}): Promise<RecurringPaymentCollectionVerification> {
  const logProofMismatch = (
    reason:
      | "persisted_evidence_mismatch"
      | "missing_verified_addresses"
      | "on_chain_instruction_mismatch"
  ): void => {
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
    logProofMismatch("persisted_evidence_mismatch");
    throw conflict("Recurring payment collection evidence does not match the due payment");
  }
  if (
    !input.recurringPayment.plan_pda ||
    !input.recurringPayment.subscription_pda ||
    !input.subscription.subscription_authority_address ||
    !input.subscription.subscriber_token_account
  ) {
    logProofMismatch("missing_verified_addresses");
    throw conflict("Recurring payment collection is missing verified addresses");
  }

  const planPda = input.recurringPayment.plan_pda;
  const subscriptionPda = input.recurringPayment.subscription_pda;
  const subscriptionAuthorityAddress = input.subscription.subscription_authority_address;
  const subscriberTokenAccount = input.subscription.subscriber_token_account;

  const rpc = createClusterRpc();
  const mint = assertValidAddress(input.recurringPayment.token, "token");
  const mintFacts = await readMintFacts(mint);
  const amountBaseUnits = parseDecimalAmount(input.recurringPayment.amount, mintFacts.decimals);
  const confirmedTransaction = await getTransaction(rpc, input.signature);
  if (!confirmedTransaction) {
    return { kind: "not_indexed" };
  }
  if (confirmedTransaction.err !== null) {
    return { kind: "failed_on_chain" };
  }
  const [eventAuthority] = await subscriptionsProgram.findEventAuthorityPda();
  const transferHookAccounts =
    input.sentTransferHookAccounts === null
      ? await resolveCollectionTransferHookAccounts({
          mintFacts,
          mint,
          amount: amountBaseUnits,
          authority: assertValidAddress(subscriptionAuthorityAddress, "subscriptionAuthority"),
          source: assertValidAddress(subscriberTokenAccount, "subscriberTokenAccount"),
          destination: input.destinationTokenAccount,
        })
      : input.sentTransferHookAccounts;

  let hasExpectedInstruction = false;
  for (const parsedInstruction of confirmedTransaction.instructions) {
    const instruction = subscriptionsInstructionFromRpc(parsedInstruction);
    if (instruction === null) continue;
    if (
      await matchesRecurringTransferInstruction({
        instruction,
        amountBaseUnits,
        sourceAddress: input.recurringPayment.source_address,
        subscriberTokenAccount,
        subscriptionAuthorityAddress,
        subscriptionPda,
        planPda,
        destinationTokenAccount: input.destinationTokenAccount,
        token: input.recurringPayment.token,
        tokenProgram: mintFacts.tokenProgram,
        eventAuthority,
        transferHookAccounts,
      })
    ) {
      hasExpectedInstruction = true;
      break;
    }
  }
  if (!hasExpectedInstruction) {
    logProofMismatch("on_chain_instruction_mismatch");
    return { kind: "instruction_mismatch" };
  }

  return {
    kind: "proven",
    proof: {
      attemptId: input.attempt.id,
      dueAt: input.dueAt,
      destinationTokenAccount: input.destinationTokenAccount,
      signature: input.signature,
      slot: confirmedTransaction.slot,
      transferId: input.transfer.id,
    },
  };
}

/**
 * The fresh path's proof: a pull it just confirmed must verify now, so every other outcome is
 * the error it answers today.
 *
 * @param verification - What verification found.
 * @returns The proof.
 * @throws AppError SOLANA_RPC_ERROR when the transaction is not indexed yet.
 * @throws AppError TRANSACTION_FAILED when it failed on chain.
 * @throws AppError CONFLICT when it does not carry the expected pull.
 */
function requireProvenCollection(
  verification: RecurringPaymentCollectionVerification
): VerifiedRecurringPaymentCollection {
  switch (verification.kind) {
    case "proven":
      return verification.proof;
    case "not_indexed":
      throw solanaRpcError(
        "Recurring payment collection is confirmed but not yet indexed; retry shortly"
      );
    case "failed_on_chain":
      throw transactionFailed("Recurring payment collection failed on-chain");
    case "instruction_mismatch":
      throw conflict(
        "Confirmed transaction does not prove the expected recurring payment collection"
      );
    default:
      return assertNever(verification);
  }
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
          AND status = ANY(?::text[])
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
      [...COLLECTABLE_RECURRING_PAYMENT_STATUSES],
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
 * Refuses an automated collection whose period failed within the retry cooldown, before its
 * pre-image read spends RPC calls on a claim the lock would refuse anyway. A manual collection
 * is never cooled down.
 *
 * @param input - The collection about to be claimed.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.collectionSource - Who starts the collection.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPayment - The schedule's due cycle.
 * @param input.attemptedAt - When the collection starts.
 * @throws AppError CONFLICT while the period is cooling down.
 */
async function refuseCoolingDownCollection(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  collectionSource: RecurringCollectionSource;
  organizationId: string;
  projectId: string;
  recurringPayment: RecurringPaymentCollectionCycleRow;
  attemptedAt: string;
}): Promise<void> {
  if (input.collectionSource !== "automated") return;
  if (await hasRecentCollectionFailure(input.subscriptionsRepo, input)) {
    throw conflict("Recurring payment collection is cooling down after a failed attempt");
  }
}

/**
 * Claims a due period for a collection: under the lock collectors take before
 * they sign, one transaction writes the attempt (carrying the request's
 * Idempotency-Key, HOO-1918) and the transfer it will submit, linked. Every
 * keyed attempt therefore has a transfer, and a same-key retry is answered
 * from them. Returns null when the cycle moved on or another attempt holds it.
 */
async function claimCollectionUnderRecurringLock(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: RecurringPaymentCollectionCycleRow;
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
    const claimed = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: recurringPayment.subscription_id,
      transferId: null,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
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
      amount: recurringPayment.amount,
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
    }),
    enforceCooldown: true,
  });
}

/**
 * Atomically fails a collection attempt and its linked transfer, so the period is retried after
 * the cooldown. Both status writes share one transaction: split, they could strand a processing
 * transfer behind a failed attempt and block the retry. Each write is compared and set on the
 * status the caller read its row in, and the attempt's must also be one a failure may be written
 * on; a row that moved since (the generic tracker saw the transfer confirmed, another run settled
 * the attempt) is logged, the transaction rolls back, and the next recovery reads both again. An
 * attempt is never confirmed here, only by `finalizeRecurringPaymentCollection`.
 *
 * @param input - The attempt, its transfer as the caller read it, and why it failed.
 * @param input.env - The API environment.
 * @param input.organizationId - The attempt's organization.
 * @param input.projectId - The attempt's project.
 * @param input.recurringPaymentId - The schedule the attempt collects for.
 * @param input.attempt - The attempt to fail.
 * @param input.transfer - Its transfer as the caller read it, or null when none was linked.
 * @param input.submittedSignature - The pull's saved signature, or null when none was saved.
 * @param input.error - Why the attempt failed.
 * @throws ResumedStepUnsettledError when the transfer reads successful, or either row is no
 *   longer in the status it was read in; nothing is written.
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
  const transfer = input.transfer;
  const metadata = retryCollectionMetadata({
    metadata: input.attempt.metadata,
    transferId: transfer === null ? null : transfer.id,
    ...collectionRetryMetadata(input.error),
  });
  const rowMoved = (
    event:
      | "sdp_api_recurring_payment_collection_transfer_moved"
      | "sdp_api_recurring_payment_collection_attempt_moved",
    expectedStatus: PaymentTransferStatus | PaymentSubscriptionCollectionAttemptStatus | null
  ): ResumedStepUnsettledError => {
    logEvent("error", {
      event,
      organization_id: input.organizationId,
      project_id: input.projectId,
      recurring_payment_id: input.recurringPaymentId,
      attempt_id: input.attempt.id,
      transfer_id: transfer === null ? null : transfer.id,
      expected_status: expectedStatus,
      signature: input.submittedSignature,
    });
    return new ResumedStepUnsettledError();
  };
  const transferMoved = (): ResumedStepUnsettledError =>
    rowMoved(
      "sdp_api_recurring_payment_collection_transfer_moved",
      transfer === null ? null : transfer.status
    );
  if (transfer !== null && isSuccessfulPaymentTransferStatus(transfer.status)) {
    throw transferMoved();
  }

  await getDb(input.env).transaction(async (tx) => {
    if (transfer !== null) {
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
              AND status = ?`
        )
        .bind(
          input.submittedSignature !== null,
          input.submittedSignature,
          message,
          failedAt,
          transfer.id,
          input.organizationId,
          input.projectId,
          transfer.status
        )
        .run();
      if (transferRows === 0) {
        throw transferMoved();
      }
    }

    const attemptRows = await tx
      .prepare(
        `UPDATE payment_subscription_collection_attempts
            SET transfer_id = CASE WHEN ?::boolean THEN ? ELSE transfer_id END,
                status = 'failed',
                signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
                error = ?,
                metadata = ?::jsonb,
                updated_at = ?
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = ?
            AND status = ANY(?::text[])`
      )
      .bind(
        transfer !== null,
        transfer === null ? null : transfer.id,
        input.submittedSignature !== null,
        input.submittedSignature,
        message,
        JSON.stringify(metadata),
        failedAt,
        input.attempt.id,
        input.organizationId,
        input.projectId,
        input.attempt.status,
        [...COLLECTION_ATTEMPT_STATUSES_FAILABLE]
      )
      .run();
    if (attemptRows === 0) {
      throw rowMoved("sdp_api_recurring_payment_collection_attempt_moved", input.attempt.status);
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
      status: isSuccessfulPaymentTransferStatus(expectedTransferStatus)
        ? expectedTransferStatus
        : "confirmed",
      signature: input.proof.signature,
      slot: Number(input.proof.slot),
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
    if (!(journalError instanceof Error) || journalError instanceof ResumedStepUnsettledError) {
      throw journalError;
    }
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
 * Finishes the collection attempt an earlier run left in flight for `dueAt`, reading its saved
 * pull through the step reader before anything is written. An attempt that never linked a
 * transfer or never saved a signature fails once it is stale. A saved pull that is dropped
 * fails the attempt and its transfer, so the period is retried after the cooldown; one that
 * landed is verified against its confirmed transaction and finalized, or failed when it is past
 * expiry and its signature contradicts the pull (`finishLandedRecurringPaymentCollection`); one
 * that is pending, or landed but not yet proven, answers 409 and writes nothing, so the attempt's
 * `updated_at` keeps the cron revisiting it every tick. A keyed request adopts the attempt before it answers
 * for a pending or landed pull; a dropped one is left to the fresh claim that follows.
 *
 * @param input - The schedule, its subscription and the due period to recover.
 * @param input.env - The API environment.
 * @param input.recurringRepo - The tenant's recurring payments repository.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.paymentsRepo - The tenant's payments repository.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPayment - The schedule.
 * @param input.subscription - The schedule's subscription.
 * @param input.dueAt - The period whose in-flight attempt is recovered.
 * @param input.idempotencyKey - The keyed collect request's key; absent for lifecycle and cron recovery.
 * @returns The finalized rows when the pull landed, or null when nothing is in flight or the
 *   attempt was failed and the caller may claim the period afresh.
 * @throws ResumedStepUnsettledError when the saved pull is pending or not yet proven.
 */
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

  const step = await readRecurringPaymentCollectionStep({
    recurringPayment: input.recurringPayment,
    attempt: existing,
    transfer,
    signature: recoveredSignature,
  });
  switch (step.state) {
    case "dropped":
      // The tracker saw this signature succeed while the delegation shows no pull: only the
      // signature can settle it, so it is verified as a landed pull past its expiry.
      if (isSuccessfulPaymentTransferStatus(transfer.status)) {
        await adoptRecoveredCollectionAttempt({ ...input, attempt: existing });
        return finishLandedRecurringPaymentCollection({
          ...input,
          attempt: existing,
          transfer,
          signature: recoveredSignature,
          pastExpiry: true,
        });
      }
      await markRecurringPaymentCollectionFailedAtomically({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.recurringPayment.id,
        attempt: existing,
        transfer,
        submittedSignature: recoveredSignature,
        error: new Error("Recurring payment collection expired without landing"),
      });
      return null;
    case "pending":
      await adoptRecoveredCollectionAttempt({ ...input, attempt: existing });
      throw new ResumedStepUnsettledError();
    case "landed":
      await adoptRecoveredCollectionAttempt({ ...input, attempt: existing });
      return finishLandedRecurringPaymentCollection({
        ...input,
        attempt: existing,
        transfer,
        signature: recoveredSignature,
        pastExpiry:
          transfer.last_valid_block_height !== null &&
          step.blockHeight > BigInt(transfer.last_valid_block_height),
      });
    case "unsent":
      throw internalError("Recurring payment collection read its saved pull as unsent");
    default:
      return assertNever(step);
  }
}

/**
 * Reads a collection attempt's saved pull through the step reader, against the delegation's
 * pre-image saved with its signature and the transfer's stored expiry. Every signed attempt
 * carries a pre-image (`persistSigned` writes both, and migration 0153 failed the in-flight
 * attempts signed before it), so one without is an invariant breach.
 *
 * @param input - The attempt's rows and saved signature.
 * @param input.recurringPayment - The schedule, for its subscription delegation.
 * @param input.attempt - The in-flight attempt, for its token, amount and pre-image.
 * @param input.transfer - The attempt's transfer, for the saved pull's expiry.
 * @param input.signature - The saved pull's signature.
 * @returns The saved pull as the chain shows it.
 * @throws AppError INTERNAL_ERROR when the attempt has no pre-image or the schedule no delegation.
 */
async function readRecurringPaymentCollectionStep(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
}): Promise<RecurringPaymentStepRead> {
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.recurringPayment.id,
    attempt_id: input.attempt.id,
    step: "collect",
  };
  const periodStartTs = input.attempt.delegation_period_start_ts_before;
  const amountPulled = input.attempt.delegation_amount_pulled_before;
  if (periodStartTs === null || amountPulled === null) {
    throw internalError("Recurring payment collection attempt is signed without its pre-image");
  }
  if (input.recurringPayment.subscription_pda === null) {
    throw internalError("Recurring payment collection is missing its subscription delegation");
  }
  return readRecurringPaymentStep({
    effect: collectionPulledEffect({
      subscriptionPda: assertValidAddress(
        input.recurringPayment.subscription_pda,
        "subscriptionPda"
      ),
      mint: assertValidAddress(input.attempt.token, "token"),
      amount: input.attempt.amount,
      preImage: { periodStartTs: BigInt(periodStartTs), amountPulled: BigInt(amountPulled) },
      logContext,
    }),
    savedSignature: input.signature,
    lastValidBlockHeight: input.transfer.last_valid_block_height,
    logContext,
  });
}

/**
 * Records a keyed collect request's Idempotency-Key on the attempt it recovers. This request
 * then answers for the period: a retry of it finds the attempt instead of collecting the next
 * one once the due date moves on. An attempt another key already answers for is that request's
 * (a null-key cron attempt is adopted): recovering it here would leave this key free to pull the
 * next period, so it is refused as in flight, unstored.
 *
 * @param input - The request's key and the attempt it recovers.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.organizationId - The attempt's organization.
 * @param input.projectId - The attempt's project.
 * @param input.attempt - The recovered attempt.
 * @param input.idempotencyKey - The request's key; the cron has none.
 * @throws AppError CONFLICT when another key answers for the attempt.
 */
async function adoptRecoveredCollectionAttempt(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  organizationId: string;
  projectId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  idempotencyKey?: string | null;
}): Promise<void> {
  if (!input.idempotencyKey) return;
  const adopted = await input.subscriptionsRepo.adoptCollectionAttemptIdempotencyKey({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!adopted) {
    throw conflict("Recurring payment collection is already processing");
  }
}

/**
 * Finalizes a recovered pull the step reader saw land: re-reads the schedule and subscription,
 * verifies the confirmed transaction against them, and confirms the transfer and attempt and
 * advances the due date in one transaction. Only the signature proves the pull was this
 * attempt's: until the saved send's expiry an unproven one stays pending. Past it, a signature
 * that failed on chain cannot have moved money, so it is logged and the attempt failed; the
 * program's per-period cap refuses a second pull in the same period. A signature still not
 * indexed, or one whose instruction the matcher does not recognize (a transfer-hook account
 * resolved differently since), may still be a pull that moved money, and failing it would retry
 * it into the next period, so it is logged by kind and stays pending. A failed-on-chain signature
 * whose transfer the tracker already marked successful cannot be failed either (the transfer guard
 * refuses it), so it stays pending too. Those three may never settle, so they bump the attempt's
 * `updated_at` (only while it is processing) and leave the cron's oldest-first recovery batch for
 * one stale window instead of starving the attempts behind them; every other pending answer
 * writes nothing.
 *
 * @param input - The recovered attempt and the schedule it collects for.
 * @param input.env - The API environment.
 * @param input.recurringRepo - The tenant's recurring payments repository.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPayment - The schedule as recovery found it.
 * @param input.subscription - The subscription as recovery found it.
 * @param input.dueAt - The period the pull collects.
 * @param input.attempt - The recovered attempt.
 * @param input.transfer - The attempt's transfer.
 * @param input.signature - The landed pull's signature.
 * @param input.pastExpiry - Whether the step read saw the chain past the saved send's expiry.
 * @returns The finalized rows, or null when the attempt was failed.
 * @throws ResumedStepUnsettledError when the pull is not proven and the attempt stays in flight.
 */
async function finishLandedRecurringPaymentCollection(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  dueAt: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
  signature: Signature;
  pastExpiry: boolean;
}): Promise<{
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
} | null> {
  const currentRecurringPayment = await input.recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!currentRecurringPayment) {
    throw internalError("Recurring payment not found while finishing its collection");
  }
  const currentSubscription = await input.subscriptionsRepo.getSubscriptionById({
    subscriptionId: input.subscription.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!currentSubscription) {
    throw internalError("Subscription not found while finishing its collection");
  }
  const destinationTokenAccount = currentRecurringPayment.destination_token_account
    ? assertValidAddress(
        currentRecurringPayment.destination_token_account,
        "destinationTokenAccount"
      )
    : await resolveDestinationTokenAccount({
        destinationAddress: currentRecurringPayment.destination_address,
        token: currentRecurringPayment.token,
      });
  const verification = await verifyRecurringPaymentCollection({
    recurringPayment: currentRecurringPayment,
    subscription: currentSubscription,
    attempt: input.attempt,
    transfer: input.transfer,
    signature: input.signature,
    dueAt: input.dueAt,
    destinationTokenAccount,
    sentTransferHookAccounts: null,
  });
  if (verification.kind === "proven") {
    return finalizeRecurringPaymentCollection({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: currentRecurringPayment,
      subscription: currentSubscription,
      attempt: input.attempt,
      transfer: input.transfer,
      proof: verification.proof,
    });
  }
  if (!input.pastExpiry) {
    throw new ResumedStepUnsettledError();
  }
  const unproven = {
    organization_id: input.organizationId,
    project_id: input.projectId,
    recurring_payment_id: input.recurringPayment.id,
    attempt_id: input.attempt.id,
    transfer_id: input.transfer.id,
    transfer_status: input.transfer.status,
    signature: input.signature,
    last_valid_block_height: input.transfer.last_valid_block_height,
  };
  switch (verification.kind) {
    case "not_indexed":
      logEvent("error", {
        event: "sdp_api_recurring_payment_collection_unindexed_past_expiry",
        ...unproven,
      });
      await rotateStuckCollectionAttempt(input);
      throw new ResumedStepUnsettledError();
    case "instruction_mismatch":
      logEvent("error", {
        event: "sdp_api_recurring_payment_collection_instruction_mismatch_past_expiry",
        ...unproven,
      });
      await rotateStuckCollectionAttempt(input);
      throw new ResumedStepUnsettledError();
    case "failed_on_chain":
      logEvent("error", {
        event: "sdp_api_recurring_payment_collection_failed_on_chain_past_expiry",
        ...unproven,
      });
      break;
    default:
      return assertNever(verification);
  }
  if (isSuccessfulPaymentTransferStatus(input.transfer.status)) {
    await rotateStuckCollectionAttempt(input);
  }
  await markRecurringPaymentCollectionFailedAtomically({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPayment.id,
    attempt: input.attempt,
    transfer: input.transfer,
    submittedSignature: input.signature,
    error: new Error("Recurring payment collection could not be proven on chain before it expired"),
  });
  return null;
}

/**
 * Moves a processing attempt that may never settle to the back of the cron's recovery order by
 * bumping its `updated_at`, writing nothing else. An attempt another writer already moved is left
 * as it is.
 *
 * @param input - The attempt to rotate.
 * @param input.subscriptionsRepo - The tenant's subscriptions repository.
 * @param input.organizationId - The attempt's organization.
 * @param input.projectId - The attempt's project.
 * @param input.attempt - The attempt.
 */
async function rotateStuckCollectionAttempt(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  organizationId: string;
  projectId: string;
  attempt: PaymentSubscriptionCollectionAttemptRow;
}): Promise<void> {
  await input.subscriptionsRepo.updateCollectionAttempt({
    attemptId: input.attempt.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "processing",
    updatedAt: new Date().toISOString(),
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

    await refuseCoolingDownCollection({
      subscriptionsRepo,
      collectionSource: input.collectionSource,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      attemptedAt: nowIso,
    });
    const delegationPreImage = await readCollectionDelegationPreImage({
      subscriptionsRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: subscription.id,
      subscriptionPda: assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda"),
    });
    const linkedCollection = await claimCollectionUnderRecurringLock({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      recurringPayment,
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

    const sourceOwner = assertValidAddress(input.recurringPayment.source_address, "sourceAddress");
    const destinationOwner = assertValidAddress(
      input.recurringPayment.destination_address,
      "destinationAddress"
    );
    const mint = assertValidAddress(input.recurringPayment.token, "token");
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

    const mintFacts = await readMintFacts(mint);
    const { tokenProgram } = mintFacts;
    const [sourceTokenAccount] = await findAssociatedTokenPda({
      owner: sourceOwner,
      tokenProgram,
      mint,
    });
    const amountBaseUnits = parseDecimalAmount(input.recurringPayment.amount, mintFacts.decimals);
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
    const transferHookAccounts = await resolveCollectionTransferHookAccounts({
      mintFacts,
      mint,
      amount: amountBaseUnits,
      authority: subscriptionAuthority,
      source: sourceTokenAccount,
      destination: receiverAta,
    });
    const sponsor = await resolveRecurringPaymentSponsor({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
    });
    const payer = createNoopSigner(sponsor.feePayer);
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

    submissionStore = createRecurringCollectionSignedSubmissionStore({
      env: input.env,
      attempt,
      transfer,
      delegationPreImage,
    });
    const signature = await sendSubscriptionInstructions({
      movement: "recurring.collect",
      env: input.env,
      sourceWallet: input.sourceWallet,
      sourceSigner,
      instructions: [createDestinationAtaInstruction, collectInstruction],
      sponsorshipScope: sponsor.sponsorshipScope,
      feePayer: sponsor.feePayer,
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
    const verification = await verifyRecurringPaymentCollection({
      recurringPayment: recurringPaymentWithDestination,
      subscription,
      attempt,
      transfer,
      signature,
      dueAt,
      destinationTokenAccount: receiverAta,
      sentTransferHookAccounts: transferHookAccounts,
    });
    const proof = requireProvenCollection(verification);

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
