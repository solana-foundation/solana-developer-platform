/**
 * DvP program PDA derivations that live outside the vendored `verify.ts`.
 *
 * `verify.ts` is vendored unchanged from `solana-foundation/dvp`, so SDP-specific
 * PDA helpers that are not part of the upstream codama output live here.
 */

import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS as DVP_SWAP_PROGRAM_ADDRESS } from "./generated/programs/dvpSwapProgram";

/** Seed prefix of the per-trade nonce tombstone (`NONCE_TOMBSTONE_SEED`). */
const NONCE_TOMBSTONE_SEED = "nonce";

const textEncoder = new TextEncoder();

/**
 * Derives the per-trade nonce tombstone PDA (seeds `["nonce", swap_dvp]`).
 *
 * A trade's nonce is a PDA seed, so a replay with the same terms would derive
 * the same `SwapDvp` address and overwrite a live trade. The tombstone is a
 * tiny account created alongside the trade whose sole purpose is to mark the
 * nonce as spent: its existence at this PDA is what `CreateDvp` checks before
 * accepting a nonce. Rejected nonces are burned — the tombstone stays even when
 * the trade it was created for is closed, so the nonce can never be reused.
 *
 * @param swapDvp - The trade account address the tombstone is keyed to.
 * @returns The tombstone address.
 */
export async function findDvpNonceTombstonePda(swapDvp: Address): Promise<Address> {
  const [tombstone] = await getProgramDerivedAddress({
    programAddress: DVP_SWAP_PROGRAM_ADDRESS,
    seeds: [textEncoder.encode(NONCE_TOMBSTONE_SEED), getAddressEncoder().encode(swapDvp)],
  });
  return tombstone;
}
