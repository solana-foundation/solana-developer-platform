import { sumDecimalAmounts } from "@sdp/payments/decimal";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionSize,
  getTransactionSizeLimit,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { badRequest, recipientNotSponsorable } from "@/lib/errors";
import type { RecentBlockhash, ResolvedRecipient, SplTokenContext } from "./types";

export const DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION = 20;

export interface RecipientInstructionGroup extends ResolvedRecipient {
  instructions: Instruction[];
  /** The associated token account an SPL recipient receives into; null for SOL. */
  destinationTokenAccount: Address | null;
}

export interface TransactionChunk {
  recipientIndexes: number[];
  instructions: Instruction[];
  message: ReturnType<typeof buildBatchTransactionMessage>;
  amount: string;
}

/**
 * The rent the fee payer funds for recipient token accounts, against Kora's per-transaction
 * outflow limit. Every recipient token account of one batch shares a mint, so each new one costs
 * the same rent.
 */
export interface SponsoredRentBudget {
  /** Kora's `max_allowed_lamports`: the most one chunk may move out of the fee payer. */
  maxLamportsPerTransaction: bigint;
  rentPerTokenAccount: bigint;
  /** Recipient token accounts absent when the batch was planned: only these get a create. */
  missingTokenAccounts: ReadonlySet<Address>;
  /**
   * Recipient token account addresses holding lamports without being a token account of the
   * batch's token program. SDP refuses their recipients up front: creating such an account may
   * need a fee-payer System Transfer to top it up, and Kora charges full rent for the create
   * regardless, so the plan cannot price it.
   */
  prefundedTokenAccounts: ReadonlySet<Address>;
}

/** A recipient with the associated token account it receives into. */
export interface TokenAccountRecipient extends ResolvedRecipient {
  destinationTokenAccount: Address;
}

/**
 * Derives each recipient's associated token account for the batch's mint.
 *
 * @param tokenContext - The batch's SPL token parameters.
 * @param recipients - Resolved recipients, in request order.
 * @returns The recipients with their destination token accounts, in request order.
 */
export function deriveDestinationTokenAccounts(
  tokenContext: SplTokenContext,
  recipients: ResolvedRecipient[]
): Promise<TokenAccountRecipient[]> {
  return Promise.all(
    recipients.map(async (recipient) => {
      const [destinationTokenAccount] = await findAssociatedTokenPda({
        owner: recipient.destinationAddress,
        tokenProgram: tokenContext.tokenProgram,
        mint: tokenContext.mintAddress,
      });
      return { ...recipient, destinationTokenAccount };
    })
  );
}

/**
 * Builds one system transfer per recipient of a SOL batch.
 *
 * @param params.recipients - Resolved recipients with lamport amounts.
 * @param params.sourceSigner - Signer for the source wallet.
 * @returns One instruction group per recipient, in request order.
 */
export function buildSolInstructionGroups(params: {
  recipients: ResolvedRecipient[];
  sourceSigner: TransactionSigner;
}): RecipientInstructionGroup[] {
  return params.recipients.map((recipient) => ({
    ...recipient,
    destinationTokenAccount: null,
    instructions: [
      getTransferSolInstruction({
        source: params.sourceSigner,
        destination: recipient.destinationAddress,
        amount: recipient.amountBaseUnits,
      }),
    ],
  }));
}

/**
 * Builds the per-recipient instruction groups of an SPL batch: a checked transfer, preceded by an
 * idempotent create-ATA funded by the fee payer only when the recipient's token account was
 * missing at planning. Kora charges full rent for every fee-payer-funded ATA create whose inner
 * `CreateAccount` its simulation does not show, so a create for an account that already exists
 * would spend the whole rent against the limit while funding nothing.
 *
 * @param params.tokenContext - The batch's SPL token parameters.
 * @param params.recipients - Recipients with their destination token accounts.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address sponsoring the transactions.
 * @param params.missingTokenAccounts - Destination token accounts absent at planning.
 * @returns One instruction group per recipient, in request order.
 */
export function buildSplInstructionGroups(params: {
  tokenContext: SplTokenContext;
  recipients: TokenAccountRecipient[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  missingTokenAccounts: ReadonlySet<Address>;
}): RecipientInstructionGroup[] {
  const { tokenContext } = params;
  const feePayerSigner = createNoopSigner(params.feePayer);
  return params.recipients.map((recipient) => {
    const transferInstruction = getTransferCheckedInstruction(
      {
        source: tokenContext.sourceTokenAccount,
        mint: tokenContext.mintAddress,
        destination: recipient.destinationTokenAccount,
        authority: params.sourceSigner,
        amount: recipient.amountBaseUnits,
        decimals: tokenContext.decimals,
      },
      { programAddress: tokenContext.tokenProgram }
    );
    const instructions: Instruction[] = params.missingTokenAccounts.has(
      recipient.destinationTokenAccount
    )
      ? [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: feePayerSigner,
            ata: recipient.destinationTokenAccount,
            owner: recipient.destinationAddress,
            mint: tokenContext.mintAddress,
            tokenProgram: tokenContext.tokenProgram,
          }),
          transferInstruction,
        ]
      : [transferInstruction];
    return { ...recipient, instructions };
  });
}

/**
 * Assembles a version-0 transaction message for one chunk's instructions.
 *
 * @param params.instructions - Flattened instructions for the chunk.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime for the message.
 * @returns The compiled transaction message.
 */
function buildBatchTransactionMessage(params: {
  instructions: Instruction[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
}) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(params.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: params.lifetime.blockhash,
          lastValidBlockHeight: params.lifetime.lastValidBlockHeight,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(params.instructions, m),
    (m) => addSignersToTransactionMessage([params.sourceSigner], m)
  );
}

/**
 * Combines instruction groups into a candidate transaction chunk.
 *
 * @param groups - Instruction groups to include in the chunk.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime for the chunk's message.
 * @returns The chunk with its message and summed decimal amount.
 */
function buildCandidateChunk(
  groups: RecipientInstructionGroup[],
  params: {
    sourceSigner: TransactionSigner;
    feePayer: Address;
    lifetime: RecentBlockhash;
  }
): TransactionChunk {
  const instructions = [
    ...groups.flatMap((group) => group.instructions),
    // Identical chunks sharing a blockhash still need distinct transaction signatures.
    {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [],
      data: new TextEncoder().encode(crypto.randomUUID()),
    },
  ];
  return {
    recipientIndexes: groups.map((group) => group.index),
    instructions,
    message: buildBatchTransactionMessage({
      instructions,
      sourceSigner: params.sourceSigner,
      feePayer: params.feePayer,
      lifetime: params.lifetime,
    }),
    amount: sumDecimalAmounts(groups.map((group) => group.amount)),
  };
}

/**
 * Rejects a chunk whose compiled transaction exceeds the Solana size limit.
 *
 * @param chunk - Candidate chunk to validate.
 */
function assertTransactionFits(chunk: TransactionChunk): void {
  const transaction = compileTransaction(chunk.message);
  if (isTransactionWithinSizeLimit(transaction)) {
    return;
  }

  throw badRequest("A batch transaction exceeds Solana transaction size limits", {
    transactionSize: getTransactionSize(transaction),
    transactionSizeLimit: getTransactionSizeLimit(transaction),
    recipientCount: chunk.recipientIndexes.length,
  });
}

/**
 * The recipient token account a group's idempotent create funds, or null when the group creates
 * none (SOL) or its account already existed when the batch was planned.
 *
 * @param group - The recipient's instruction group.
 * @param rentBudget - The batch's sponsored rent budget.
 * @returns The token account whose rent the fee payer funds, or null.
 */
function fundedTokenAccount(
  group: RecipientInstructionGroup,
  rentBudget: SponsoredRentBudget
): Address | null {
  const tokenAccount = group.destinationTokenAccount;
  if (tokenAccount === null) return null;
  return rentBudget.missingTokenAccounts.has(tokenAccount) ? tokenAccount : null;
}

/**
 * Refuses a batch naming recipients the fee sponsor can never fund, before any chunk is built, so
 * nothing is stored or signed for it:
 * - a token account address that already holds lamports without being a token account: creating
 *   it may need a fee-payer System Transfer, and Kora charges full rent for the create regardless,
 *   so the plan cannot price it;
 * - a new token account whose rent alone exceeds the per-transaction limit: no chunk could carry it.
 *
 * @param groups - Instruction groups in recipient order.
 * @param rentBudget - The batch's sponsored rent budget.
 * @throws AppError `RECIPIENT_NOT_SPONSORABLE` naming the refused recipients and the reason.
 */
function assertRecipientsSponsorable(
  groups: RecipientInstructionGroup[],
  rentBudget: SponsoredRentBudget
): void {
  const prefundedIndexes = groups
    .filter(
      (group) =>
        group.destinationTokenAccount !== null &&
        rentBudget.prefundedTokenAccounts.has(group.destinationTokenAccount)
    )
    .map((group) => group.index);
  if (prefundedIndexes.length > 0) {
    throw recipientNotSponsorable(
      `recipients.${prefundedIndexes[0]} has a token account address that already holds lamports without being a token account; SDP cannot price creating it for the fee sponsor`,
      { reason: "token_account_address_prefunded", recipientIndexes: prefundedIndexes }
    );
  }

  if (rentBudget.rentPerTokenAccount <= rentBudget.maxLamportsPerTransaction) {
    return;
  }
  const overLimitIndexes = groups
    .filter((group) => fundedTokenAccount(group, rentBudget) !== null)
    .map((group) => group.index);
  if (overLimitIndexes.length === 0) {
    return;
  }
  throw recipientNotSponsorable(
    `recipients.${overLimitIndexes[0]} needs a new token account whose rent (${rentBudget.rentPerTokenAccount} lamports) exceeds the ${rentBudget.maxLamportsPerTransaction} lamports the fee sponsor funds per transaction`,
    {
      reason: "rent_exceeds_limit",
      recipientIndexes: overLimitIndexes,
      rentLamportsPerTokenAccount: rentBudget.rentPerTokenAccount.toString(),
      maxSponsoredLamportsPerTransaction: rentBudget.maxLamportsPerTransaction.toString(),
    }
  );
}

/**
 * Packs instruction groups into transaction chunks, greedily filling each
 * chunk up to the recipient cap, the Solana transaction size limit, and the
 * rent Kora lets one transaction move out of the fee payer. Recipients whose
 * token account already exists carry no create and fund no rent, so they fill
 * a chunk up to the other two limits; a token account two recipients share is
 * funded once per chunk, as Kora counts it once per transaction.
 *
 * @param params.groups - Instruction groups in recipient order.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @param params.rentBudget - The rent the fee payer funds for new recipient token accounts.
 * @returns The chunks to submit, each within transaction size and sponsored outflow limits.
 * @throws AppError `RECIPIENT_NOT_SPONSORABLE` for a prefunded token account address, or a new
 *   token account whose rent alone exceeds the limit.
 */
export function chunkInstructionGroups(params: {
  groups: RecipientInstructionGroup[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
  rentBudget: SponsoredRentBudget;
}): TransactionChunk[] {
  assertRecipientsSponsorable(params.groups, params.rentBudget);

  const chunks: TransactionChunk[] = [];
  let pending: RecipientInstructionGroup[] = [];
  let pendingRent = 0n;
  const pendingFundedAccounts = new Set<Address>();

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const chunk = buildCandidateChunk(pending, params);
    assertTransactionFits(chunk);
    chunks.push(chunk);
    pending = [];
    pendingRent = 0n;
    pendingFundedAccounts.clear();
  };

  for (const group of params.groups) {
    if (pending.length >= params.maxRecipientsPerTransaction) {
      flush();
    }

    const funded = fundedTokenAccount(group, params.rentBudget);
    if (
      funded !== null &&
      !pendingFundedAccounts.has(funded) &&
      pendingRent + params.rentBudget.rentPerTokenAccount >
        params.rentBudget.maxLamportsPerTransaction
    ) {
      flush();
    }

    const candidateGroups = [...pending, group];
    const candidate = buildCandidateChunk(candidateGroups, params);
    if (isTransactionWithinSizeLimit(compileTransaction(candidate.message))) {
      pending = candidateGroups;
    } else {
      flush();
      pending = [group];
      assertTransactionFits(buildCandidateChunk(pending, params));
    }

    if (funded !== null && !pendingFundedAccounts.has(funded)) {
      pendingFundedAccounts.add(funded);
      pendingRent += params.rentBudget.rentPerTokenAccount;
    }
  }

  flush();
  return chunks;
}
