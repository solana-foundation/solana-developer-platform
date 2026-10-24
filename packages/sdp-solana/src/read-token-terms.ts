/**
 * Reads Token Terms through the caller's client (ADR 0012): one
 * `getMultipleAccounts([mint, Clock])` request, so the fee epoch belongs to
 * the slot that held these mint bytes. For the packages and
 * the legacy-RPC modules (issuance, DvP, Private Channels, Earn) that hold
 * their own client; the API's Payments planner reads through
 * `services/token-movement/read-terms.ts`, which also batches destinations.
 *
 * Nothing is cached: every field moves value, and a mint with a close
 * authority can be closed and created again at the same address.
 */

import {
  assertAccountExists,
  fetchEncodedAccounts,
  type GetMultipleAccountsApi,
  type Rpc,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import type { TokenAsset, UnreadMint } from "./asset-ref";
import {
  decodeTokenTerms,
  type MintTokenTerms,
  TOKEN_TERMS_REFUSALS,
  TokenTermsError,
} from "./token-terms";

/**
 * The terms of a mint, read live.
 *
 * @param request - The mint, with the token program a catalogue entry names,
 * or unread (its owner decides the program).
 * @returns The terms at the slot of the read.
 * @throws {TokenTermsError} When no account exists at the mint address, or it
 * is not a mint SDP can move (see `decodeTokenTerms`).
 */
export async function fetchTokenTerms(
  rpc: Rpc<GetMultipleAccountsApi>,
  request: TokenAsset | UnreadMint
): Promise<MintTokenTerms> {
  const [mint, clock] = await fetchEncodedAccounts(rpc, [request.mint, SYSVAR_CLOCK_ADDRESS], {
    commitment: "confirmed",
  });
  if (!mint.exists) {
    throw new TokenTermsError(
      TOKEN_TERMS_REFUSALS.notMint,
      `No account exists at the mint address ${request.mint}`
    );
  }
  // The Clock sysvar always exists; a node answering otherwise is not one to
  // price a movement by, so this fails like any failed read.
  assertAccountExists(clock);
  return decodeTokenTerms(request, { mint, clock });
}
