import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { onTestFinished, vi } from "vitest";
import * as sourceFunds from "@/routes/payments/ramps/offramp/source-funds";

/**
 * Answers the two reads a MoonPay off-ramp quote makes before its row: the
 * sell estimate (quoting `fiatAmount`) and the source balance (funded). For
 * tests of other quote behavior; `payments.ramps.offramp-quote-checks.test.ts`
 * covers the checks themselves.
 *
 * @param fiatAmount - The payout the estimate quotes.
 * @returns The estimate spy.
 */
export function stubOfframpQuoteReads(fiatAmount = "20.69") {
  const estimate = vi
    .spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "estimateOfframp")
    .mockImplementation(async (_context, input) => ({
      provider: "moonpay",
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount,
      cryptoAmount: input.cryptoAmount,
      exchangeRate: "1",
      fees: { currency: input.fiatCurrency, total: "0", provider: "0" },
    }));
  const funded = vi.spyOn(sourceFunds, "assertOfframpSourceFunded").mockResolvedValue(undefined);
  onTestFinished(() => {
    estimate.mockRestore();
    funded.mockRestore();
  });
  return estimate;
}
