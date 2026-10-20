import type { PaymentRampEstimate, RampProviderEstimateResult } from "@sdp/types/payments";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";
import { estimateLimitCopy, estimateRateCopy, formatEstimateFigure } from "./ramp-estimate-copy";

const messages = getMessages("en");
const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

function estimate(overrides: Partial<PaymentRampEstimate>): PaymentRampEstimate {
  return {
    provider: "moonpay",
    direction: "offramp",
    fiatCurrency: "USD",
    assetRail: "sol.solana",
    fiatAmount: "107.12",
    cryptoAmount: "1",
    exchangeRate: "109.21",
    fees: { currency: "USD", total: "2.09" },
    ...overrides,
  };
}

describe("formatEstimateFigure", () => {
  it("prints money with two places and keeps dust to six", () => {
    expect(formatEstimateFigure("25", "en")).toBe("25.00");
    expect(formatEstimateFigure("1234.5", "en")).toBe("1,234.50");
    expect(formatEstimateFigure("0.004321", "en")).toBe("0.004321");
    expect(formatEstimateFigure("not a number", "en")).toBe("not a number");
  });
});

describe("estimateRateCopy", () => {
  it("prices one unit of the crypto in the fiat", () => {
    expect(estimateRateCopy(t, estimate({}), "en")).toBe("1 SOL = 109.21 USD");
    expect(
      estimateRateCopy(t, estimate({ assetRail: "usdc.solana", exchangeRate: "0.998" }), "en")
    ).toBe("1 USDC = 0.998 USD");
  });

  it("says nothing for a rate it can't read", () => {
    expect(estimateRateCopy(t, estimate({ exchangeRate: "0" }), "en")).toBeNull();
    expect(estimateRateCopy(t, estimate({ exchangeRate: "" }), "en")).toBeNull();
  });
});

describe("estimateLimitCopy", () => {
  const belowMinimum: RampProviderEstimateResult = {
    provider: "moonpay",
    status: "error",
    error: "Amount is below the minimum",
    reason: "amount_below_minimum",
    limit: { amount: "19.92405", currency: "USDC" },
  };

  it("names the bound in the currency the amount was given in", () => {
    expect(estimateLimitCopy(t, belowMinimum)).toBe("Minimum is 19.92405 USDC");
    expect(
      estimateLimitCopy(t, {
        ...belowMinimum,
        reason: "amount_above_maximum",
        limit: { amount: "10000", currency: "USD" },
      })
    ).toBe("Maximum is 10000 USD");
  });

  it("leaves any other answer to the caller", () => {
    expect(
      estimateLimitCopy(t, {
        provider: "moonpay",
        status: "error",
        error: "Request failed with status 502",
      })
    ).toBeNull();
    expect(estimateLimitCopy(t, undefined)).toBeNull();
  });
});
