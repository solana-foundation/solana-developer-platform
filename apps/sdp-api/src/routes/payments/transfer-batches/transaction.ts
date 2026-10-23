import { formatDecimalAmount } from "@sdp/solana/amount";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionSize,
  getTransactionSizeLimit,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { badRequest } from "@/lib/errors";
import { buildPlannedLeg, type PlannedTokenMovement } from "@/services/token-movement/build";
import type { RecentBlockhash, ResolvedRecipient } from "./types";

export const DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION = 20;

export interface RecipientInstructionGroup extends ResolvedRecipient {
  instructions: Instruction[];
}

export interface TransactionChunk {
  recipientIndexes: number[];
  instructions: Instruction[];
  message: ReturnType<typeof buildBatchTransactionMessage>;
  /** The sum of the chunk's recipients' debits, in token units. */
  amount: string;
}

/**
 * Builds the per-recipient instruction groups for the batch, each through the
 * token movement builder from the batch's plan: a system transfer for native
 * SOL; for a token, the destination's idempotent create and a checked
 * transfer (with its fee whenever the mint has a fee config).
 *
 * @param params.plan - The batch's plan; its legs are the recipients'.
 * @param params.recipients - Resolved recipients with their legs.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address sponsoring the transactions.
 * @returns One instruction group per recipient, in request order.
 */
export function buildInstructionGroups(params: {
  plan: PlannedTokenMovement;
  recipients: ResolvedRecipient[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
}): RecipientInstructionGroup[] {
  return params.recipients.map((recipient) => ({
    ...recipient,
    instructions: buildPlannedLeg(params.plan, recipient.leg, {
      authority: params.sourceSigner,
      feePayer: params.feePayer,
    }),
  }));
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
    amount: chunkDebit(groups),
  };
}

/** The sum of a chunk's recipients' debits, in token units. */
function chunkDebit(groups: readonly RecipientInstructionGroup[]): string {
  const [first] = groups;
  if (first === undefined) {
    throw new Error("A transaction chunk has at least one recipient");
  }
  return formatDecimalAmount(
    groups.reduce((total, group) => total + group.leg.quote.debit, 0n),
    first.leg.quote.decimals
  );
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
