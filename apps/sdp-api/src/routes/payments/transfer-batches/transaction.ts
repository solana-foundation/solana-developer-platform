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
import { badRequest, internalError, sponsoredRentOverCap } from "@/lib/errors";
import type { RecentBlockhash, ResolvedRecipient, TokenContext } from "./types";

export const DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION = 20;

export interface RecipientInstructionGroup extends ResolvedRecipient {
  instructions: Instruction[];
  destinationTokenAccount?: Address;
}

/**
 * What the sponsor funds per transaction beyond the network fee (HOO-2024): rent for each
 * recipient token account a chunk creates, under Kora's `max_allowed_lamports`. Kora counts that
 * rent against the cap and not the network fee (sdp-infra `kora/cloud-run/kora.mainnet.toml`).
 */
export interface SponsoredRentLimit {
  /** Rent in lamports, by destination token account the batch would create. */
  rentByTokenAccount: ReadonlyMap<Address, bigint>;
  /** The scope's Kora `max_allowed_lamports`; null when the batch creates nothing. */
  capLamports: bigint | null;
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
 * The rent the sponsor funds for a chunk of these groups: each distinct token account it creates,
 * counted once. Chunks are submitted concurrently, so an account two chunks name counts in both.
 */
function sponsoredRentOf(
  groups: readonly RecipientInstructionGroup[],
  limit: SponsoredRentLimit
): bigint {
  const created = new Map<Address, bigint>();
  for (const group of groups) {
    if (group.destinationTokenAccount === undefined) continue;
    // Absent from the map: the account exists, so the chunk creates nothing for it.
    const rent = limit.rentByTokenAccount.get(group.destinationTokenAccount);
    if (rent !== undefined) created.set(group.destinationTokenAccount, rent);
  }
  let total = 0n;
  for (const rent of created.values()) total += rent;
  return total;
}

/**
 * Packs instruction groups into transaction chunks, greedily filling each chunk up to the
 * recipient cap, the Solana transaction size limit and the sponsor's per-transaction rent cap.
 * A recipient whose own token account rent exceeds the cap is refused before any chunk is built,
 * so nothing is stored or sent.
 *
 * @param params.groups - Instruction groups in recipient order.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @param params.sponsoredRent - Rent each created token account costs the sponsor, and its cap.
 * @returns The chunks to submit, each within transaction size limits and the rent cap.
 * @throws AppError `SPONSORED_RENT_OVER_CAP` when one recipient's rent alone exceeds the cap.
 */
export function chunkInstructionGroups(params: {
  groups: RecipientInstructionGroup[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
  sponsoredRent: SponsoredRentLimit;
}): TransactionChunk[] {
  const { sponsoredRent } = params;
  const capLamports =
    sponsoredRent.rentByTokenAccount.size === 0 ? null : sponsoredRent.capLamports;
  if (sponsoredRent.rentByTokenAccount.size > 0 && capLamports === null) {
    throw internalError("A batch that creates token accounts was planned without the rent cap");
  }
  if (capLamports !== null) {
    for (const group of params.groups) {
      const rentLamports = sponsoredRentOf([group], sponsoredRent);
      if (rentLamports > capLamports) {
        throw sponsoredRentOverCap({
          recipientIndex: group.index,
          rentLamports: rentLamports.toString(),
          capLamports: capLamports.toString(),
        });
      }
    }
  }

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
    if (capLamports !== null && sponsoredRentOf(candidateGroups, sponsoredRent) > capLamports) {
      flush();
      pending = [group];
      continue;
    }
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
