import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { GET_MULTIPLE_ACCOUNTS_LIMIT, getMinimumBalanceForRentExemption } from "@sdp/rpc/solana";
import { type Address, fetchEncodedAccounts, type TransactionSigner } from "@solana/kit";
import { solanaRpcError } from "@/lib/errors";
import {
  buildSolInstructionGroups,
  buildSplInstructionGroups,
  chunkInstructionGroups,
  deriveDestinationTokenAccounts,
  type RecipientInstructionGroup,
  type SponsoredRentBudget,
  type TransactionChunk,
} from "./transaction";
import type { RecentBlockhash, ResolvedRecipient, TokenContext } from "./types";

/**
 * Rent-exempt minimums by cluster and data size, kept for the process; a failed read is forgotten.
 * A rent feature gate can change the cluster's rent parameters mid-process, but rent has only ever
 * gone down, so a stale value over-plans (more, smaller chunks), which is safe.
 */
const rentByClusterAndSize = new Map<string, Promise<bigint>>();

/**
 * The rent-exempt minimum for an account of `size` bytes on the open scope's cluster, read once
 * per process per cluster and size.
 *
 * @param size - Account data size in bytes.
 * @returns The rent-exempt minimum, in lamports.
 */
function readRentExemption(size: number): Promise<bigint> {
  const cacheKey = `${currentClusterScope().cluster}:${size}`;
  const cached = rentByClusterAndSize.get(cacheKey);
  if (cached !== undefined) return cached;
  const read = getMinimumBalanceForRentExemption(createClusterRpc(), size).catch(
    (error: unknown) => {
      rentByClusterAndSize.delete(cacheKey);
      throw error;
    }
  );
  rentByClusterAndSize.set(cacheKey, read);
  return read;
}

/**
 * Classifies recipient token account addresses at `confirmed`, one `getMultipleAccounts` per
 * {@link GET_MULTIPLE_ACCOUNTS_LIMIT} addresses: an address owned by the token program is an
 * initialized token account, one with no account is missing, and any other account (lamports sent
 * to the address, so system-owned) is prefunded.
 *
 * @param accounts - Distinct token account addresses.
 * @param tokenProgram - The batch mint's token program.
 * @returns The missing and the prefunded addresses.
 * @throws AppError `SOLANA_RPC_ERROR` when the RPC answers for a different number of addresses
 *   than it was asked about.
 */
async function readTokenAccountStates(
  accounts: readonly Address[],
  tokenProgram: Address
): Promise<{ missing: Set<Address>; prefunded: Set<Address> }> {
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
  const missing = new Set<Address>();
  const prefunded = new Set<Address>();
  for (const account of fetched.flat()) {
    if (!account.exists) {
      missing.add(account.address);
    } else if (account.programAddress !== tokenProgram) {
      prefunded.add(account.address);
    }
  }
  return { missing, prefunded };
}

/**
 * Plans a batch's transactions, for create and `/estimate` alike so both report the same chunks.
 *
 * Kora (deployed revision `f0377c0`) charges every fee-payer-funded ATA create against
 * `max_allowed_lamports` at full rent unless its simulation shows the inner `CreateAccount`,
 * idempotent creates of accounts that already exist included. So the plan reads each recipient's
 * token account first, emits a create only for the missing ones, and packs chunks so their rent
 * stays within the limit; recipients whose account exists cost nothing against it.
 *
 * A token account that appears after planning makes its create fund nothing, which Kora still
 * charges as planned. One closed after planning has no create, so its `transferChecked` fails in
 * simulation and the chunk's executor settles it as failed.
 *
 * @param params.tokenContext - Resolved token parameters for the batch.
 * @param params.recipients - Resolved recipients with base-unit amounts.
 * @param params.sourceSigner - Signer for the source wallet.
 * @param params.feePayer - Fee payer address sponsoring the transactions.
 * @param params.lifetime - Blockhash lifetime applied to each chunk.
 * @param params.maxRecipientsPerTransaction - Upper bound on recipients per chunk.
 * @param params.maxSponsoredLamportsPerTransaction - Kora's `max_allowed_lamports`.
 * @returns The chunks to submit and the rent budget they were packed against.
 * @throws AppError `RECIPIENT_NOT_SPONSORABLE` for a recipient the fee sponsor can never fund.
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
  const { tokenContext } = params;
  let groups: RecipientInstructionGroup[];
  let rentBudget: SponsoredRentBudget;
  if (tokenContext.kind === "sol") {
    groups = buildSolInstructionGroups({
      recipients: params.recipients,
      sourceSigner: params.sourceSigner,
    });
    rentBudget = {
      maxLamportsPerTransaction: params.maxSponsoredLamportsPerTransaction,
      rentPerTokenAccount: 0n,
      missingTokenAccounts: new Set(),
      prefundedTokenAccounts: new Set(),
    };
  } else {
    const recipients = await deriveDestinationTokenAccounts(tokenContext, params.recipients);
    const [rentPerTokenAccount, states] = await Promise.all([
      readRentExemption(tokenContext.newTokenAccountSize),
      readTokenAccountStates(
        [...new Set(recipients.map((recipient) => recipient.destinationTokenAccount))],
        tokenContext.tokenProgram
      ),
    ]);
    rentBudget = {
      maxLamportsPerTransaction: params.maxSponsoredLamportsPerTransaction,
      rentPerTokenAccount,
      missingTokenAccounts: states.missing,
      prefundedTokenAccounts: states.prefunded,
    };
    groups = buildSplInstructionGroups({
      tokenContext,
      recipients,
      sourceSigner: params.sourceSigner,
      feePayer: params.feePayer,
      missingTokenAccounts: states.missing,
    });
  }
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
