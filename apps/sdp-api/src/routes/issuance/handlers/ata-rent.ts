import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { Address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTokenSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import type { Env } from "@/types/env";

/** The fee-payer-funded ATA rent a mint execution would carry. */
export interface MintAtaRent {
  tokenAccount: Address;
  rentLamports: string;
  solAmount: string;
  payer: "sponsor" | "custody_wallet";
}

/**
 * Preflight the value-moving effect the pinned Mosaic mint builder adds beyond
 * the requested token amount: a create-associated-token-idempotent instruction
 * paid by the resolved fee payer whenever the destination ATA does not exist
 * yet. That rent-exempt SOL outflow must ride the mint's policy candidate as a
 * native SOL leg so amount, approval and velocity rules bind fresh-destination
 * mints (SOLA9-464); it is also recorded on the governed wallet operation.
 *
 * Returns null when the destination ATA already exists, so the mint creates no
 * account and the fee payer funds no rent.
 *
 * The payer attribution mirrors mint execution's own fee-payer resolution:
 * issuance mints run with `feePayment: "sponsored"`, so `createMosaicService`
 * activates the Kora sponsor exactly when `KORA_RPC_URL` is configured and the
 * custody wallet pays otherwise.
 *
 * @param params - The runtime env, the token mint, and the mint destination.
 * @returns The ATA rent the fee payer would fund, or null when none applies.
 */
export async function preflightMintAtaRent(params: {
  env: Env;
  mint: Address;
  destination: Address;
}): Promise<MintAtaRent | null> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: params.destination,
    mint: params.mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const rpc = solanaRpc.createRpc(params.env);
  if (await solanaRpc.accountExists(rpc, tokenAccount)) {
    return null;
  }
  // The associated-token program creates the base token-account layout; any
  // mint-extension space needs a separate reallocation the mint never issues.
  const rentLamports = await solanaRpc.getMinimumBalanceForRentExemption(rpc, getTokenSize());
  return {
    tokenAccount,
    rentLamports: rentLamports.toString(),
    solAmount: formatDecimalAmount(rentLamports, 9),
    payer: params.env.KORA_RPC_URL ? "sponsor" : "custody_wallet",
  };
}
