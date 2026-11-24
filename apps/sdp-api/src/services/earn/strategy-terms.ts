import {
  AmountError,
  decimalScale,
  formatDecimalAmount,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import { EARN_SWAP_MAX_SLIPPAGE_BPS } from "@sdp/types/earn";
import { badRequest } from "@/lib/errors";

/** Quantize a displayed quote at its actual mint scale, rounding protection down. */
export function strategyOutputFloor(value: string, decimals: number, slippageBps: number): string {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > EARN_SWAP_MAX_SLIPPAGE_BPS
  ) {
    throw badRequest(`slippageBps must be between 0 and ${EARN_SWAP_MAX_SLIPPAGE_BPS}`);
  }
  const units = parseDecimalAmount(value, decimals);
  const floor = (units * BigInt(10_000 - slippageBps)) / 10_000n;
  if (floor <= 0n)
    throw badRequest("The quoted output is too small for a protected strategy action");
  return formatDecimalAmount(floor, decimals);
}

/** Size a token-denominated exit at mint precision without rounding shares up. */
export function strategySharesForTokenAmount(input: {
  shares: string;
  tokenValue: string;
  tokenAmount: string;
  shareDecimals: number;
}): string {
  const valueScale = decimalScale(input.tokenValue);
  let value = parseDecimalAmount(input.tokenValue, valueScale);
  const scale = Math.max(valueScale, decimalScale(input.tokenAmount));
  let amount: bigint;
  try {
    if (scale > valueScale) value = parseDecimalAmount(input.tokenValue, scale);
    amount = parseDecimalAmount(input.tokenAmount, scale);
  } catch (error) {
    if (error instanceof AmountError)
      throw badRequest("Withdrawal token amount is out of range or has unsupported precision");
    throw error;
  }
  if (value <= 0n || amount <= 0n || amount > value)
    throw badRequest("Withdrawal exceeds the live strategy token value");
  const shares = parseDecimalAmount(input.shares, input.shareDecimals);
  const units = (shares * amount) / value;
  if (units <= 0n) throw badRequest("Withdrawal is smaller than one strategy share unit");
  return formatDecimalAmount(units, input.shareDecimals);
}
