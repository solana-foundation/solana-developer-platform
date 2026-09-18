import { decimalScale, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import type { EarnVaultPosition } from "@sdp/types";
import {
  compareUnsignedDecimals,
  isPositiveDecimal,
  MAX_AMOUNT_LENGTH,
  parseUnsignedDecimal,
} from "./earn-decimal";

export const VAULT_WITHDRAWAL_AMOUNT_DECIMALS = 6;
export const VAULT_WITHDRAWAL_SHARE_DECIMALS = 9;
const MAX_EARN_SHARE_DECIMALS = VAULT_WITHDRAWAL_SHARE_DECIMALS;

export type VaultWithdrawalAmountValidation =
  | { kind: "valid"; canonicalAmount: string }
  | { kind: "invalid" };

export function validateVaultWithdrawalAmount(value: string): VaultWithdrawalAmountValidation {
  const amount = parseUnsignedDecimal(value, { maxLength: MAX_AMOUNT_LENGTH });
  if (
    !amount ||
    amount.fraction.length > VAULT_WITHDRAWAL_AMOUNT_DECIMALS ||
    !isPositiveDecimal(amount.canonical)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", canonicalAmount: amount.canonical };
}

/**
 * Validate a share-denominated redemption without inventing a cash value.
 * This Earn share-entry surface supports the nine-decimal scale used by the
 * current provider contracts; the provider builder remains the authority for
 * the selected fund's exact mint scale.
 */
export function validateVaultWithdrawalShares(value: string): VaultWithdrawalAmountValidation {
  const shares = parseUnsignedDecimal(value, { maxLength: MAX_AMOUNT_LENGTH });
  if (
    !shares ||
    shares.fraction.length > VAULT_WITHDRAWAL_SHARE_DECIMALS ||
    !isPositiveDecimal(shares.canonical)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", canonicalAmount: shares.canonical };
}

/** Exact share intent for a provider-settled redemption, capped by live holdings. */
export function vaultProviderOrderShares(
  value: string,
  position: Pick<EarnVaultPosition, "withdrawableShares">
): string | undefined {
  const validation = validateVaultWithdrawalShares(value);
  if (validation.kind !== "valid" || position.withdrawableShares === undefined) {
    return undefined;
  }
  const comparison = compareUnsignedDecimals(
    validation.canonicalAmount,
    position.withdrawableShares
  );
  return comparison === undefined || comparison === 1 ? undefined : validation.canonicalAmount;
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
    !isPositiveDecimal(parsedDivisor.canonical)
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
    !isPositiveDecimal(position.shares)
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
 * Most current vault integrations use six-decimal shares. Preserve any finer
 * scale observed in the live balance, up to this Earn UI's supported ceiling.
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
    MAX_EARN_SHARE_DECIMALS,
    Math.max(6, decimalScale(position.shares), decimalScale(position.withdrawableShares))
  );
  const shares = multiplyDivideDecimal(
    validation.canonicalAmount,
    position.shares,
    position.tokenValue,
    shareDecimals
  );
  return shares && isPositiveDecimal(shares) ? shares : undefined;
}
