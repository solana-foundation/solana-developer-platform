import { parseDecimalAmount } from "@sdp/solana/amount";
import { type Address, blockhash, createNoopSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { SplTokenContext } from "@/routes/payments/transfer-batches/transaction";
import type { RecentBlockhash, ResolvedRecipient } from "@/routes/payments/transfer-batches/types";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";

/** A legacy SPL Token batch of a synthetic six-decimal mint. */
export const TEST_SPL_TOKEN_CONTEXT = {
  kind: "spl",
  token: syntheticAddress(700),
  decimals: 6,
  mintAddress: syntheticAddress(700),
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  sourceTokenAccount: syntheticAddress(701),
  toBaseUnits: (amount) => parseDecimalAmount(amount, 6),
  newTokenAccountSize: 165,
} as const satisfies SplTokenContext;

export const TEST_BATCH_SOURCE_SIGNER = createNoopSigner(syntheticAddress(702));

export const TEST_BATCH_FEE_PAYER = syntheticAddress(703);

export const TEST_BATCH_LIFETIME: RecentBlockhash = {
  blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"),
  lastValidBlockHeight: 1000n,
};

/**
 * One resolved recipient of one token per owner, in order, with synthetic counterparty ids.
 *
 * @param owners - Each recipient's destination wallet.
 * @returns The recipients, indexed by position.
 */
export function testBatchRecipients(owners: readonly Address[]): ResolvedRecipient[] {
  return owners.map((destinationAddress, index) => ({
    index,
    externalId: null,
    counterpartyId: `cpty_batch_plan_${index}`,
    counterpartyAccountId: `cpacct_batch_plan_${index}`,
    destinationAddress,
    amount: "1",
    amountBaseUnits: 1_000_000n,
  }));
}
