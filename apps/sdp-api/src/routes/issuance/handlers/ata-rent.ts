import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { Address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTokenSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { AppError } from "@/lib/errors";
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

const LAMPORTS_PATTERN = /^\d+$/;

/**
 * Whether an evaluated rent fact still covers the rent the mint would carry
 * now: the evaluation pinned a lamport amount at least as large as the fresh
 * quote. Anything else — no evaluated fact, an unreadable one, or a fresh
 * quote above it — fails closed.
 */
function evaluatedAtaRentCovers(evaluated: unknown, fresh: MintAtaRent): boolean {
  if (typeof evaluated !== "object" || evaluated === null || Array.isArray(evaluated)) {
    return false;
  }
  const { rentLamports } = evaluated as Record<string, unknown>;
  if (typeof rentLamports !== "string" || !LAMPORTS_PATTERN.test(rentLamports)) {
    return false;
  }
  return BigInt(rentLamports) >= BigInt(fresh.rentLamports);
}

/**
 * Submission-boundary TOCTOU guard: policy evaluated the mint's ATA rent from
 * a preflight, and the mint only submits afterward. A destination owner can
 * close an empty ATA in between, so the idempotent create the builder prepends
 * would land and charge rent the evaluated decision never saw. Re-preflight
 * the live chain state and fail closed unless the evaluated rent facts still
 * cover what the fee payer would now fund (SOLA9-464):
 *
 * - the ATA exists now → the idempotent create is a no-op, no rent is charged;
 * - it does not, and the evaluation carried an at-least-as-large rent → covered;
 * - it does not, and no rent was evaluated (or the fresh quote exceeds it) →
 *   the mint would carry an ungoverned outflow → refuse before submission.
 *
 * @param params - The runtime env, the token mint, the destination, and the
 *   rent facts the evaluated decision recorded (rawPayload.ataRent).
 */
export async function assertMintAtaRentCoveredByEvaluation(params: {
  env: Env;
  mint: Address;
  destination: Address;
  evaluatedAtaRent: unknown;
}): Promise<void> {
  const freshAtaRent = await preflightMintAtaRent(params);
  if (freshAtaRent === null || evaluatedAtaRentCovers(params.evaluatedAtaRent, freshAtaRent)) {
    return;
  }
  throw new AppError(
    "FORBIDDEN",
    "Mint destination ATA state changed after policy evaluation; the fee payer would fund ATA rent the evaluated decision does not cover",
    { tokenAccount: freshAtaRent.tokenAccount, rentLamports: freshAtaRent.rentLamports }
  );
}
