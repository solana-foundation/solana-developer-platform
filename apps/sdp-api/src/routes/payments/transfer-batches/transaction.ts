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
import { badRequest, signingRejected } from "@/lib/errors";
import type { RecentBlockhash, ResolvedRecipient, TokenContext } from "./types";

export const DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION = 20;

export interface RecipientInstructionGroup extends ResolvedRecipient {
  instructions: Instruction[];
  destinationTokenAccount?: Address;
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
  /** Recipient token accounts absent when the batch was planned: their idempotent create funds rent. */
  missingTokenAccounts: ReadonlySet<Address>;
}

/**
 * Builds the per-recipient instruction groups for the batch: a single system
 * transfer for SOL, or an idempotent create-ATA plus checked transfer for SPL
 * tokens.
 *
 * @param params.tokenContext - Resolved token parameters for the batch.
 * @param params.recipients - Resolved recipients with base-unit amounts.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address sponsoring the transactions.
 * @returns One instruction group per recipient, in request order.
 */
export async function buildInstructionGroups(params: {
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
}): Promise<RecipientInstructionGroup[]> {
  if (params.tokenContext.kind === "sol") {
    return params.recipients.map((recipient) => ({
      ...recipient,
      instructions: [
        getTransferSolInstruction({
          source: params.sourceSigner,
          destination: recipient.destinationAddress,
          amount: recipient.amountBaseUnits,
        }),
      ],
    }));
  }

  const tokenContext = params.tokenContext;
  const feePayerSigner = createNoopSigner(params.feePayer);
  return Promise.all(
    params.recipients.map(async (recipient) => {
      const [destinationTokenAccount] = await findAssociatedTokenPda({
        owner: recipient.destinationAddress,
        tokenProgram: tokenContext.tokenProgram,
        mint: tokenContext.mintAddress,
      });
      const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
        payer: feePayerSigner,
        ata: destinationTokenAccount,
        owner: recipient.destinationAddress,
        mint: tokenContext.mintAddress,
        tokenProgram: tokenContext.tokenProgram,
      });
      const transferInstruction = getTransferCheckedInstruction(
        {
          source: tokenContext.sourceTokenAccount,
          mint: tokenContext.mintAddress,
          destination: destinationTokenAccount,
          authority: params.sourceSigner,
          amount: recipient.amountBaseUnits,
          decimals: tokenContext.decimals,
        },
        { programAddress: tokenContext.tokenProgram }
      );

      return {
        ...recipient,
        destinationTokenAccount,
        instructions: [createDestinationAtaInstruction, transferInstruction],
      };
    })
  );
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
  return tokenAccount !== undefined && rentBudget.missingTokenAccounts.has(tokenAccount)
    ? tokenAccount
    : null;
}

/**
 * Refuses a batch with a recipient whose new token account alone costs more rent than Kora lets
 * one transaction move out of the fee payer: no chunk could carry it, so Kora would refuse it at
 * signing. Runs before any chunk is built, so nothing is stored or signed for the batch.
 *
 * @param groups - Instruction groups in recipient order.
 * @param rentBudget - The batch's sponsored rent budget.
 */
function assertRecipientRentSponsorable(
  groups: RecipientInstructionGroup[],
  rentBudget: SponsoredRentBudget
): void {
  if (rentBudget.rentPerTokenAccount <= rentBudget.maxLamportsPerTransaction) {
    return;
  }
  const recipientIndexes = groups
    .filter((group) => fundedTokenAccount(group, rentBudget) !== null)
    .map((group) => group.index);
  if (recipientIndexes.length === 0) {
    return;
  }
  throw signingRejected(
    `recipients.${recipientIndexes[0]} needs a new token account whose rent (${rentBudget.rentPerTokenAccount} lamports) exceeds the ${rentBudget.maxLamportsPerTransaction} lamports the fee sponsor funds per transaction`,
    {
      recipientIndexes,
      rentLamportsPerTokenAccount: rentBudget.rentPerTokenAccount.toString(),
      maxSponsoredLamportsPerTransaction: rentBudget.maxLamportsPerTransaction.toString(),
    }
  );
}

/**
 * Packs instruction groups into transaction chunks, greedily filling each
 * chunk up to the recipient cap, the Solana transaction size limit, and the
 * rent Kora lets one transaction move out of the fee payer. Recipients whose
 * token account already exists fund no rent, so they fill a chunk up to the
 * other two limits; a token account two recipients share is funded once per
 * chunk.
 *
 * @param params.groups - Instruction groups in recipient order.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @param params.rentBudget - The rent the fee payer funds for new recipient token accounts.
 * @returns The chunks to submit, each within transaction size and sponsored outflow limits.
 * @throws AppError `SIGNING_REJECTED` when one recipient's new token account alone exceeds the limit.
 */
export function chunkInstructionGroups(params: {
  groups: RecipientInstructionGroup[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
  rentBudget: SponsoredRentBudget;
}): TransactionChunk[] {
  assertRecipientRentSponsorable(params.groups, params.rentBudget);

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
