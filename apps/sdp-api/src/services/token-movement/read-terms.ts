/**
 * Reads Token Terms from the chain (ADR 0012).
 *
 * RPC budget: one `getMultipleAccounts` request for the mint and the Clock
 * sysvar together, so the fee epoch and the display time belong to the slot
 * that held these mint bytes. Native SOL makes no request.
 *
 * Nothing is cached. Every field moves value: a fee can rise, a hook can be
 * set, and a mint with a close authority can be closed and created again at
 * the same address with other decimals.
 */

import { createClusterRpc } from "@sdp/rpc/factory";
import type { AssetRequest } from "@sdp/solana/asset-ref";
import {
  decodeTokenTerms,
  NATIVE_TOKEN_TERMS,
  type TokenTerms,
  TokenTermsError,
} from "@sdp/solana/token-terms";
import { assertAccountExists, fetchEncodedAccounts } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { badRequest } from "@/lib/errors";

/**
 * The terms of the asset a request names, read live on the open cluster scope.
 *
 * @param asset - The resolved request asset.
 * @returns Static terms for native SOL; otherwise the mint's terms at the slot read.
 * @throws AppError (400) when no account exists at the mint address, the
 * account is not a mint of a supported token program, its owner is not the
 * program the catalogue names, or it carries an extension state the program
 * refuses.
 */
export async function readTokenTerms(asset: AssetRequest): Promise<TokenTerms> {
  if (asset.kind === "native") {
    return NATIVE_TOKEN_TERMS;
  }

  const [mint, clock] = await fetchEncodedAccounts(
    createClusterRpc(),
    [asset.mint, SYSVAR_CLOCK_ADDRESS],
    { commitment: "confirmed" }
  );
  if (!mint.exists) {
    throw badRequest("Token mint account does not exist");
  }
  // The Clock sysvar always exists; a node answering otherwise is not one to
  // price a movement by, so this fails like any failed read.
  assertAccountExists(clock);

  try {
    return decodeTokenTerms(asset, { mint, clock });
  } catch (cause) {
    if (cause instanceof TokenTermsError) {
      throw badRequest(cause.message);
    }
    throw cause;
  }
}
