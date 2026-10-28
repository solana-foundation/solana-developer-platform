import { createClusterRpc } from "@sdp/rpc/factory";
import { GET_MULTIPLE_ACCOUNTS_LIMIT } from "@sdp/rpc/solana";
import { type Address, fetchEncodedAccounts, type TransactionSigner } from "@solana/kit";
import { solanaRpcError } from "@/lib/errors";
import { readAssociatedTokenAccountRent } from "@/routes/payments/token-accounts";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  type RecipientInstructionGroup,
  type SponsoredRentBudget,
  type TransactionChunk,
} from "./transaction";
import type { RecentBlockhash, ResolvedRecipient, TokenContext } from "./types";

/**
 * Which of `accounts` do not exist at `confirmed`, one `getMultipleAccounts` per
 * {@link GET_MULTIPLE_ACCOUNTS_LIMIT} addresses.
 *
 * @param accounts - Distinct account addresses to look up.
 * @returns The addresses with no account.
 * @throws AppError `SOLANA_RPC_ERROR` when the RPC answers for a different number of addresses
 *   than it was asked about.
 */
async function readMissingAccounts(accounts: readonly Address[]): Promise<Set<Address>> {
  const rpc = createClusterRpc();
  const slices: Address[][] = [];
  for (let start = 0; start < accounts.length; start += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    slices.push(accounts.slice(start, start + GET_MULTIPLE_ACCOUNTS_LIMIT));
  }
  const fetched = await Promise.all(
    slices.map(async (slice) => {
      const sliceAccounts = await fetchEncodedAccounts(rpc, slice, { commitment: "confirmed" });
      // A short answer would report an absent account as existing, and under-count its rent.
      if (sliceAccounts.length !== slice.length) {
        throw solanaRpcError(
          `getMultipleAccounts returned ${sliceAccounts.length} accounts for ${slice.length} addresses`
        );
      }
      return sliceAccounts;
    })
  );
  return new Set(
    fetched
      .flat()
      .filter((account) => !account.exists)
      .map((account) => account.address)
  );
}

/**
 * Reads what the fee payer funds for the batch's recipient token accounts: the rent of one new
 * account for the batch's mint, and which recipient accounts are absent now.
 *
 * @param params.tokenContext - Resolved token parameters for the batch.
 * @param params.groups - Instruction groups with derived destination token accounts.
 * @param params.maxLamportsPerTransaction - Kora's per-transaction fee-payer outflow limit.
 * @returns The rent budget the chunker packs against.
 */
async function readSponsoredRentBudget(params: {
  tokenContext: TokenContext;
  groups: RecipientInstructionGroup[];
  maxLamportsPerTransaction: bigint;
}): Promise<SponsoredRentBudget> {
  if (params.tokenContext.kind === "sol") {
    return {
      maxLamportsPerTransaction: params.maxLamportsPerTransaction,
      rentPerTokenAccount: 0n,
      missingTokenAccounts: new Set(),
    };
  }

  const tokenAccounts = new Set(
    params.groups.flatMap((group) =>
      group.destinationTokenAccount === undefined ? [] : [group.destinationTokenAccount]
    )
  );
  const [rentPerTokenAccount, missingTokenAccounts] = await Promise.all([
    readAssociatedTokenAccountRent(
      params.tokenContext.mintAddress,
      params.tokenContext.tokenProgram
    ),
    readMissingAccounts([...tokenAccounts]),
  ]);
  return {
    maxLamportsPerTransaction: params.maxLamportsPerTransaction,
    rentPerTokenAccount,
    missingTokenAccounts,
  };
}

/**
 * Plans a batch's transactions, for create and `/estimate` alike so both report the same chunks:
 * per-recipient instruction groups, the rent the fee payer funds for recipient token accounts
 * absent now, and chunks that keep that rent within Kora's per-transaction outflow limit.
 *
 * A token account that appears after planning only makes its idempotent create free. One closed
 * after planning makes its chunk fund more rent than planned; Kora's simulation at signing sees
 * the real outflow and refuses that chunk, which the chunk's executor settles as failed.
 *
 * @param params.tokenContext - Resolved token parameters for the batch.
 * @param params.recipients - Resolved recipients with base-unit amounts.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address sponsoring the transactions.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @param params.maxSponsoredLamportsPerTransaction - Kora's `max_allowed_lamports`.
 * @returns The chunks to submit and the rent budget they were packed against.
 * @throws AppError `SIGNING_REJECTED` when one recipient's new token account alone exceeds the limit.
 */
export async function planBatchTransactions(params: {
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
  maxSponsoredLamportsPerTransaction: bigint;
}): Promise<{ chunks: TransactionChunk[]; rentBudget: SponsoredRentBudget }> {
  const groups = await buildInstructionGroups({
    tokenContext: params.tokenContext,
    recipients: params.recipients,
    sourceSigner: params.sourceSigner,
    feePayer: params.feePayer,
  });
  const rentBudget = await readSponsoredRentBudget({
    tokenContext: params.tokenContext,
    groups,
    maxLamportsPerTransaction: params.maxSponsoredLamportsPerTransaction,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner: params.sourceSigner,
    feePayer: params.feePayer,
    lifetime: params.lifetime,
    maxRecipientsPerTransaction: params.maxRecipientsPerTransaction,
    rentBudget,
  });
  return { chunks, rentBudget };
}
