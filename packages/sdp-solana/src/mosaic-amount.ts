/**
 * Amounts for Mosaic's issuance entry points (ADR 0012, the issuance adapter).
 *
 * Mosaic's mint, burn, force-burn and force-transfer builders take a JS number
 * of token units and convert it with `decimalAmountToRaw`, which stringifies
 * the number and truncates digits past the mint's decimals. Mosaic exposes no
 * base-unit entry point, so SDP keeps the exact amount as a `TokenAmount` and
 * hands Mosaic a number only after Mosaic's own conversion of that number is
 * checked to give back exactly the same base units. A number that cannot (above
 * 2^53 base units, or one JS prints with an exponent such as `1e-7`) is refused
 * instead of moving a different amount.
 *
 * The amount's scale is checked against the mint's decimals read live, never
 * against the token row, which is a creation snapshot; the issuance rows of
 * the capability table gate the mint state.
 */

import type { Address, GetMultipleAccountsApi, Rpc } from "@solana/kit";
import { decimalAmountToRaw } from "@solana/mosaic-sdk";
import { fetchTokenTerms } from "./read-token-terms";
import { type TokenAmount, toBaseUnits } from "./token-amount";
import { support, type TokenMovementPath, type TokenMovementRefusal } from "./token-movement";

/** The capability rows Mosaic's issuance entry points move under. */
export type MosaicIssuancePath = Extract<TokenMovementPath, "issuance" | "issuance_seize">;

export const MOSAIC_AMOUNT_REFUSALS = {
  /** The mint's live state is one the path's row refuses. */
  unsupported: "unsupported",
  /** The mint's live decimals are not the scale the amount was parsed at. */
  scaleMismatch: "scale_mismatch",
  /** No JS number makes Mosaic move exactly the amount's base units. */
  inexact: "inexact",
} as const satisfies Record<string, string>;

export type MosaicAmountRefusal =
  (typeof MOSAIC_AMOUNT_REFUSALS)[keyof typeof MOSAIC_AMOUNT_REFUSALS];

/** An issuance amount SDP will not hand to Mosaic. Nothing was built or signed. */
export class MosaicAmountError extends Error {
  readonly reason: MosaicAmountRefusal;
  /** The capability refusal, for an `unsupported` mint; null otherwise. */
  readonly movementRefusal: TokenMovementRefusal | null;

  constructor(
    reason: MosaicAmountRefusal,
    message: string,
    movementRefusal: TokenMovementRefusal | null
  ) {
    super(message);
    this.name = "MosaicAmountError";
    this.reason = reason;
    this.movementRefusal = movementRefusal;
  }
}

/**
 * The number Mosaic's decimal-amount entry points take for `amount`, checked
 * with Mosaic's own `decimalAmountToRaw` to convert back to exactly its base
 * units.
 *
 * @throws {MosaicAmountError} (`inexact`) When no number does.
 */
export function mosaicDecimalAmount(amount: TokenAmount): number {
  const units = toBaseUnits(amount);
  const value = Number(amount.value);
  let raw: bigint;
  try {
    raw = decimalAmountToRaw(value, amount.decimals);
  } catch (cause) {
    throw new MosaicAmountError(
      MOSAIC_AMOUNT_REFUSALS.inexact,
      `The amount ${amount.value} cannot be handed to Mosaic exactly: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      null
    );
  }
  if (raw !== units) {
    throw new MosaicAmountError(
      MOSAIC_AMOUNT_REFUSALS.inexact,
      `The amount ${amount.value} cannot be handed to Mosaic exactly`,
      null
    );
  }
  return value;
}

/**
 * Reads the mint's terms live, refuses what `path` cannot move and an amount
 * parsed at another scale than the mint's, and returns the number Mosaic takes.
 *
 * RPC budget: one `getMultipleAccounts([mint, Clock])`.
 *
 * @throws {MosaicAmountError} With the reason the amount is refused.
 * @throws {TokenTermsError} When the account at `mint` is not a mint SDP can move.
 */
export async function mosaicAmountUnderLiveTerms(
  rpc: Rpc<GetMultipleAccountsApi>,
  mint: Address,
  amount: TokenAmount,
  path: MosaicIssuancePath
): Promise<number> {
  const terms = await fetchTokenTerms(rpc, { kind: "mint", mint });
  const decision = support(terms, path);
  if (!decision.supported) {
    throw new MosaicAmountError(
      MOSAIC_AMOUNT_REFUSALS.unsupported,
      decision.message,
      decision.refusal
    );
  }
  if (terms.decimals !== amount.decimals) {
    throw new MosaicAmountError(
      MOSAIC_AMOUNT_REFUSALS.scaleMismatch,
      `The mint has ${terms.decimals} decimals on chain, not the ${amount.decimals} SDP recorded for it`,
      null
    );
  }
  return mosaicDecimalAmount(amount);
}
