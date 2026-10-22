import type { TokenAmountEntry } from "@/app/dashboard/[projectId]/payments/use-token-amount-entry";

/**
 * An amount entry for a classic token: typed in token units, no terms read,
 * nothing to price. What a wizard holds for SOL and plain mints.
 */
export function tokenUnitsEntry(tokenAmount: string): TokenAmountEntry {
  return {
    terms: null,
    displayEntryAvailable: false,
    unit: "token",
    setUnit: () => undefined,
    displayAmount: "",
    setDisplayAmount: () => undefined,
    tokenAmount,
    quote: null,
    quoteError: null,
    quoteInFlight: false,
    canSubmitAt: () => true,
    refreshQuote: () => undefined,
  };
}
