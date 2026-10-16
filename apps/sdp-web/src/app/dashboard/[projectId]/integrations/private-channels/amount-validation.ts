import { decimalScale, isDecimalString } from "@sdp/solana/amount";
import type { MessageKey } from "@/i18n/messages";

/**
 * Returns the message key for the amount problem, or null when it is valid.
 * Applies the same rules as the API so deposits, withdrawals, and transfers all
 * reject an amount before the round trip. Keys rather than text, so the client
 * renders it in the caller's locale even when the check runs in a server action.
 */
export function getAmountError(amount: string): MessageKey | null {
  const trimmed = amount.trim();
  if (!trimmed) {
    return "DashboardPrivateChannels.common.amountRequired";
  }
  const positiveWithinMintDecimals =
    isDecimalString(trimmed) && /[1-9]/.test(trimmed) && decimalScale(trimmed) <= 6;
  return positiveWithinMintDecimals ? null : "DashboardPrivateChannels.common.amountInvalid";
}
