/**
 * Reads Token Terms through the caller's client (ADR 0012): one
 * `getMultipleAccounts([mint, Clock])` request, so the fee epoch and display
 * time belong to the slot that held these mint bytes. For the packages and
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

/** `getMultipleAccounts` takes at most this many addresses: the Clock and 99 mints. */
const MINTS_PER_READ = 99;

/**
 * The terms of many mints, read live for display (a balance list): one
 * `getMultipleAccounts` request for the Clock and up to 99 mints, the next
 * 99 in a concurrent request. A mint whose account is missing or does not
 * decode gets its error in place of terms, so one unreadable mint does not
 * hide the others.
 *
 * @param assets - Distinct mints, each with the token program its accounts are under.
 * @param options - The caller's deadline for the read, and the slot it must
 * see at least (the slot the holdings it displays were read at).
 * @returns One entry per asset, in order: its terms, or why they could not be read.
 */
export async function fetchTokenTermsOfMints(
  rpc: Rpc<GetMultipleAccountsApi>,
  assets: readonly TokenAsset[],
  options: { abortSignal: AbortSignal | undefined; minContextSlot: bigint | undefined }
): Promise<(MintTokenTerms | TokenTermsError)[]> {
  const pages: TokenAsset[][] = [];
  for (let start = 0; start < assets.length; start += MINTS_PER_READ) {
    pages.push(assets.slice(start, start + MINTS_PER_READ));
  }
  const results = await Promise.all(
    pages.map(async (page) => {
      const [clock, ...mints] = await fetchEncodedAccounts(
        rpc,
        [SYSVAR_CLOCK_ADDRESS, ...page.map((asset) => asset.mint)],
        {
          commitment: "confirmed",
          abortSignal: options.abortSignal,
          minContextSlot: options.minContextSlot,
        }
      );
      // The Clock sysvar always exists; a node answering otherwise fails the read.
      assertAccountExists(clock);
      return page.map((asset, index) => {
        const mint = mints[index];
        if (!mint.exists) {
          return new TokenTermsError(
            TOKEN_TERMS_REFUSALS.notMint,
            `No account exists at the mint address ${asset.mint}`
          );
        }
        try {
          return decodeTokenTerms(asset, { mint, clock });
        } catch (cause) {
          if (cause instanceof TokenTermsError) {
            return cause;
          }
          throw cause;
        }
      });
    })
  );
  return results.flat();
}
