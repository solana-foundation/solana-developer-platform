import { sumDecimalAmounts } from "@sdp/payments/decimal";
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
import { badRequest } from "@/lib/errors";
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
  const instructions = groups.flatMap((group) => group.instructions);
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
 * Packs instruction groups into transaction chunks, greedily filling each
 * chunk up to the recipient cap and the Solana transaction size limit.
 *
 * @param params.groups - Instruction groups in recipient order.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @returns The chunks to submit, each within transaction size limits.
 */
export function chunkInstructionGroups(params: {
  groups: RecipientInstructionGroup[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
}): TransactionChunk[] {
  const chunks: TransactionChunk[] = [];
  let pending: RecipientInstructionGroup[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const chunk = buildCandidateChunk(pending, params);
    assertTransactionFits(chunk);
    chunks.push(chunk);
    pending = [];
  };

  for (const group of params.groups) {
    if (pending.length >= params.maxRecipientsPerTransaction) {
      flush();
    }

    const candidateGroups = [...pending, group];
    const candidate = buildCandidateChunk(candidateGroups, params);
    if (isTransactionWithinSizeLimit(compileTransaction(candidate.message))) {
      pending = candidateGroups;
      continue;
    }

    flush();
    pending = [group];
    assertTransactionFits(buildCandidateChunk(pending, params));
  }

  flush();
  return chunks;
}
