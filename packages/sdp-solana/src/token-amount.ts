/**
 * Token amounts as types (ADR 0012).
 *
 * A count of base units and an exact token amount are different values, so
 * each has its own brand and no code can pass one where the other belongs.
 * Only the constructors below make them, after they check the range. The
 * display value lives with the display rule, in `token-terms.ts`.
 *
 * Client-safe: no RPC and no Node-only import. The dashboard imports it.
 */

import {
  AmountError,
  formatFixedDecimal,
  parseFixedDecimal,
  parseTokenAmount as parseU64BaseUnits,
} from "./amount";

declare const baseUnitsBrand: unique symbol;
declare const tokenAmountBrand: unique symbol;

/** The largest u64: the most base units one token account can hold. */
export const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** Mint decimals are a u8 on chain. */
const MAX_MINT_DECIMALS = 255;

/** A whole number with no sign and no leading zero. */
const BASE_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;

/** A count of a mint's smallest units, in the u64 range. This is the ledger value. */
export type BaseUnits = bigint & { readonly [baseUnitsBrand]: true };

/**
 * An exact token amount: base units ÷ 10^decimals. It is never the wallet
 * display value, which a scaled or interest-bearing mint changes.
 */
export type TokenAmount = Readonly<{
  /** Canonical decimal string: no sign, no exponent, no trailing fraction zeros. */
  value: string;
  /** The mint's decimals, the scale `value` is exact at. */
  decimals: number;
}> & { readonly [tokenAmountBrand]: true };

function assertMintDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MINT_DECIMALS) {
    throw new AmountError("Invalid decimals configuration");
  }
}

/**
 * Brands a bigint as base units.
 *
 * @param value - A count of base units.
 * @returns The same value, branded.
 * @throws {AmountError} When the value is outside the u64 range.
 */
export function baseUnits(value: bigint): BaseUnits {
  if (value < 0n || value > U64_MAX) {
    throw new AmountError("Base units must fit in an unsigned 64-bit integer");
  }
  // SAFETY: the u64 range check above is the brand's whole invariant.
  return value as BaseUnits;
}

/**
 * Parses base units from their decimal string form, as a database row or a
 * raw RPC amount holds them.
 *
 * @param value - Digits only, no sign and no leading zero.
 * @returns The branded base units.
 * @throws {AmountError} When the string is not a plain whole number or is
 * outside the u64 range.
 */
export function parseBaseUnits(value: string): BaseUnits {
  if (!BASE_UNITS_PATTERN.test(value)) {
    throw new AmountError("Base units must be a whole number without sign or leading zeros");
  }
  return baseUnits(BigInt(value));
}

/**
 * Parses a token amount at the mint's decimals.
 *
 * @param value - A plain unsigned decimal string; surrounding whitespace is ignored.
 * @param decimals - The mint's decimals.
 * @returns The canonical token amount.
 * @throws {AmountError} When the string is not a plain decimal, has more
 * fraction digits than `decimals`, or is above the u64 range in base units.
 */
export function parseTokenAmount(value: string, decimals: number): TokenAmount {
  assertMintDecimals(decimals);
  return toTokenAmount(baseUnits(parseU64BaseUnits(value, decimals)), decimals);
}

/**
 * The exact token amount of a base-unit count.
 *
 * @param units - Base units.
 * @param decimals - The mint's decimals.
 * @returns `units ÷ 10^decimals` as a canonical token amount.
 * @throws {AmountError} When `decimals` is not a u8.
 */
export function toTokenAmount(units: BaseUnits, decimals: number): TokenAmount {
  assertMintDecimals(decimals);
  // SAFETY: the value is formatted from u64 base units at a valid scale,
  // which is exactly what the brand promises.
  return { value: formatFixedDecimal(units, decimals), decimals } as TokenAmount;
}

/**
 * The base units of a token amount. Exact: a token amount is only ever built
 * from base units in the u64 range.
 *
 * @param amount - A token amount.
 * @returns `amount × 10^decimals`.
 */
export function toBaseUnits(amount: TokenAmount): BaseUnits {
  return baseUnits(parseFixedDecimal(amount.value, amount.decimals));
}
