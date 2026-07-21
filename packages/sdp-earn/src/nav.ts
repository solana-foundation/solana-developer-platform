/**
 * Pure NAV / share-price math over base-unit bigints. Share prices are decimal
 * strings (deposit-asset units per share) parsed into fixed-point bigints so
 * no floating point ever touches money.
 */

export const SHARE_PRICE_DECIMALS = 18;
const SHARE_PRICE_SCALE = 10n ** BigInt(SHARE_PRICE_DECIMALS);

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** Parse a non-negative decimal string into a bigint scaled by 10^decimals (extra precision truncated). */
export function parseDecimalScaled(value: string, decimals = SHARE_PRICE_DECIMALS): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
}

/** Current value of a share balance in deposit-asset base units, floored. */
export function positionValueBaseUnits(shareAmount: string, sharePrice: string): bigint {
  const shares = BigInt(shareAmount);
  if (shares < 0n) {
    throw new Error("Share amount must be non-negative");
  }
  return (shares * parseDecimalScaled(sharePrice)) / SHARE_PRICE_SCALE;
}

/** Shares received for a deposit at a share price, floored (platform-conservative). */
export function sharesForDepositBaseUnits(amountBaseUnits: string, sharePrice: string): bigint {
  const amount = BigInt(amountBaseUnits);
  if (amount < 0n) {
    throw new Error("Deposit amount must be non-negative");
  }
  const price = parseDecimalScaled(sharePrice);
  if (price <= 0n) {
    throw new Error("Share price must be positive");
  }
  return (amount * SHARE_PRICE_SCALE) / price;
}
