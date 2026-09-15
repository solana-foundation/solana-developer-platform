import { decimalScale, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import type { EarnVaultPosition } from "@sdp/types";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";

export const VAULT_WITHDRAWAL_AMOUNT_DECIMALS = 6;
const MAX_AMOUNT_LENGTH = 128;
const MAX_SOLANA_MINT_DECIMALS = 9;

export type VaultWithdrawalAmountValidation =
  | { kind: "valid"; canonicalAmount: string }
  | { kind: "invalid" };

export function validateVaultWithdrawalAmount(value: string): VaultWithdrawalAmountValidation {
  const amount = parseUnsignedDecimal(value, { maxLength: MAX_AMOUNT_LENGTH });
  if (
    !amount ||
    amount.fraction.length > VAULT_WITHDRAWAL_AMOUNT_DECIMALS ||
    compareUnsignedDecimals(amount.canonical, "0") !== 1
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", canonicalAmount: amount.canonical };
}

function multiplyDivideDecimal(
  left: string,
  right: string,
  divisor: string,
  outputDecimals: number
): string | undefined {
  const parsedLeft = parseUnsignedDecimal(left);
  const parsedRight = parseUnsignedDecimal(right);
  const parsedDivisor = parseUnsignedDecimal(divisor);
  if (
    !parsedLeft ||
    !parsedRight ||
    !parsedDivisor ||
    compareUnsignedDecimals(parsedDivisor.canonical, "0") !== 1
  ) {
    return undefined;
  }

  const leftScale = decimalScale(parsedLeft.canonical);
  const rightScale = decimalScale(parsedRight.canonical);
  const divisorScale = decimalScale(parsedDivisor.canonical);
  let numerator =
    parseDecimalAmount(parsedLeft.canonical, leftScale) *
    parseDecimalAmount(parsedRight.canonical, rightScale);
  let denominator = parseDecimalAmount(parsedDivisor.canonical, divisorScale);
  const scaleShift = divisorScale + outputDecimals - leftScale - rightScale;
  if (scaleShift >= 0) numerator *= 10n ** BigInt(scaleShift);
  else denominator *= 10n ** BigInt(-scaleShift);

  return formatDecimalAmount(numerator / denominator, outputDecimals);
}

/** Current stablecoin value that can be redeemed immediately, rounded down. */
export function vaultWithdrawalAvailableAmount(
  position: Pick<EarnVaultPosition, "shares" | "withdrawableShares" | "tokenValue">
): string | undefined {
  if (
    position.shares === undefined ||
    position.withdrawableShares === undefined ||
    position.tokenValue === undefined ||
    compareUnsignedDecimals(position.shares, "0") !== 1
  ) {
    return undefined;
  }
  return multiplyDivideDecimal(
    position.withdrawableShares,
    position.tokenValue,
    position.shares,
    VAULT_WITHDRAWAL_AMOUNT_DECIMALS
  );
}

/**
 * Convert the user's stablecoin amount to the exact share intent the API needs.
 * All current vault integrations use six-decimal shares. Preserve any finer
 * scale observed in the live balance, up to Solana's mint-decimal ceiling.
 */
export function vaultWithdrawalSharesForAmount(
  amount: string,
  position: Pick<EarnVaultPosition, "shares" | "withdrawableShares" | "tokenValue">
): string | undefined {
  const validation = validateVaultWithdrawalAmount(amount);
  const availableAmount = vaultWithdrawalAvailableAmount(position);
  if (
    validation.kind !== "valid" ||
    availableAmount === undefined ||
    position.shares === undefined ||
    position.withdrawableShares === undefined ||
    position.tokenValue === undefined
  ) {
    return undefined;
  }
  if (compareUnsignedDecimals(validation.canonicalAmount, availableAmount) === 1) return undefined;
  if (compareUnsignedDecimals(validation.canonicalAmount, availableAmount) === 0) {
    return position.withdrawableShares;
  }

  const shareDecimals = Math.min(
    MAX_SOLANA_MINT_DECIMALS,
    Math.max(6, decimalScale(position.shares), decimalScale(position.withdrawableShares))
  );
  const shares = multiplyDivideDecimal(
    validation.canonicalAmount,
    position.shares,
    position.tokenValue,
    shareDecimals
  );
  return shares && compareUnsignedDecimals(shares, "0") === 1 ? shares : undefined;
}
