/**
 * One quote for every token movement (ADR 0012).
 *
 * An intent says which side of the transfer its amount fixes: `debit` is what
 * leaves the source, `credit` is what the destination receives. The quote
 * splits it into debit, fee and credit in base units under the mint's terms,
 * with `debit = credit + fee`. Request fields default to `debit`; an amount
 * that is a receipt by definition (a payment request, a provider deposit) is
 * quoted as `credit`.
 *
 * Client-safe: no RPC and no Node-only import.
 */

import type { TokenMovementBasis } from "@sdp/types/token-movements";
import type { Epoch } from "@solana/kit";
import { AmountError } from "./amount";
import { type AssetRef, isSameAsset } from "./asset-ref";
import { type BaseUnits, baseUnits, type TokenAmount, toBaseUnits } from "./token-amount";
import {
  debitForCredit,
  feeFor,
  type MintTokenTerms,
  type TermsReadAt,
  type TokenTerms,
} from "./token-terms";

declare const movementQuoteBrand: unique symbol;

/** What a caller asked to move. The amount is exact token units, never a display value. */
export type MovementIntent = Readonly<{
  asset: AssetRef;
  amount: TokenAmount;
  basis: TokenMovementBasis;
}>;

/** The three base-unit amounts of one movement. */
type MovementSplit = Readonly<{ debit: BaseUnits; fee: BaseUnits; credit: BaseUnits }>;

/** A movement priced under one read of the mint's terms. */
export type MovementQuote = MovementSplit &
  Readonly<{
    intent: MovementIntent;
    decimals: number;
    /** The epoch whose fee entry priced `fee`; null when the mint has no fee config. */
    feeEpoch: Epoch | null;
    /** The read the quote is priced at; null for native SOL, whose terms are static. */
    asOf: TermsReadAt | null;
  }> & { readonly [movementQuoteBrand]: true };

function splitAtEpoch(
  terms: MintTokenTerms,
  amount: BaseUnits,
  basis: TokenMovementBasis,
  epoch: Epoch
): MovementSplit {
  switch (basis) {
    case "debit": {
      const fee = feeFor(terms, amount, epoch);
      return { debit: amount, fee, credit: baseUnits(amount - fee) };
    }
    case "credit": {
      const debit = debitForCredit(terms, amount, epoch);
      return { debit, fee: baseUnits(debit - amount), credit: amount };
    }
    default: {
      const exhaustive: never = basis;
      throw new Error(`Unknown movement basis: ${String(exhaustive)}`);
    }
  }
}

/**
 * Prices an intent under the terms read for its asset.
 *
 * @param terms - Token Terms read for `intent.asset`.
 * @param intent - What to move.
 * @returns Debit, fee and credit in base units, with the fee epoch and the
 * read they are priced at.
 * @throws {AmountError} When the amount's decimals are not the mint's, or no
 * u64 debit credits the amount.
 * @throws {Error} When the terms are for another asset: the caller read the
 * wrong mint.
 */
export function quoteMovement(terms: TokenTerms, intent: MovementIntent): MovementQuote {
  if (!isSameAsset(terms.asset, intent.asset)) {
    throw new Error("Token terms are for a different asset than the movement intent");
  }
  if (intent.amount.decimals !== terms.decimals) {
    throw new AmountError("Amount decimals do not match the mint");
  }
  const amount = toBaseUnits(intent.amount);

  if (terms.readAt === null) {
    // Native SOL: no fee.
    // SAFETY: debit equals credit and the fee is zero, the quote's invariant.
    return {
      intent,
      decimals: terms.decimals,
      debit: amount,
      fee: baseUnits(0n),
      credit: amount,
      feeEpoch: null,
      asOf: null,
    } as MovementQuote;
  }

  const { epoch } = terms.readAt;
  const split = splitAtEpoch(terms, amount, intent.basis, epoch);
  // SAFETY: `splitAtEpoch` keeps `debit = credit + fee` under the read's
  // fee entry, the quote's invariant.
  return {
    intent,
    decimals: terms.decimals,
    ...split,
    feeEpoch: terms.transferFee === null ? null : epoch,
    asOf: terms.readAt,
  } as MovementQuote;
}
