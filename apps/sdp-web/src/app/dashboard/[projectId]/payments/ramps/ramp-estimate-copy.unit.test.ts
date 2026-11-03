import { AmountError } from "@sdp/solana/amount";
import type { PaymentRampEstimate, RampProviderEstimateResult } from "@sdp/types/payments";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";
import {
  estimateFeeCopy,
  estimateLimitCopy,
  estimateRateCopy,
  formatEstimateFigure,
  youPayCopy,
} from "./ramp-estimate-copy";

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

describe("youPayCopy", () => {
  const onramp = (overrides: Partial<PaymentRampEstimate>) =>
    estimate({ direction: "onramp", ...overrides });

  it("adds fees charged on top of the amount, as Stripe does", () => {
    const copy = youPayCopy(
      t,
      {
        estimate: onramp({
          provider: "stripe",
          fiatAmount: "25",
          totalFiatAmount: "26.02",
          fees: { currency: "USD", total: "1.02" },
        }),
        amount: "25",
        fiat: "USD",
      },
      "en"
    );
    expect(copy).toEqual({ value: "26.02 USD", aside: "25.00 USD plus the provider's fees" });
  });

  it("says the fees are inside a total MoonPay's widget takes them out of", () => {
    const copy = youPayCopy(
      t,
      {
        estimate: onramp({
          fiatAmount: "21.7",
          totalFiatAmount: "25",
          fees: { currency: "USD", total: "3.3" },
        }),
        amount: "25",
        fiat: "USD",
      },
      "en"
    );
    expect(copy).toEqual({ value: "25.00 USD", aside: "Includes the provider's fees" });
  });

  it("reads an amount typed with stray spaces against the total", () => {
    const stripe = onramp({ provider: "stripe", totalFiatAmount: "26.02" });
    expect(youPayCopy(t, { estimate: stripe, amount: "25 ", fiat: "USD" }, "en")).toEqual({
      value: "26.02 USD",
      aside: "25.00 USD plus the provider's fees",
    });
  });

  it("lets the amount typed stand alone only when the provider sends no total", () => {
    expect(youPayCopy(t, { estimate: onramp({}), amount: "25", fiat: "USD" }, "en")).toEqual({
      value: "25.00 USD",
      aside: undefined,
    });
    expect(() =>
      youPayCopy(
        t,
        { estimate: onramp({ totalFiatAmount: "26,02" }), amount: "25", fiat: "USD" },
        "en"
      )
    ).toThrow(AmountError);
  });

  it("names no fees for a free buy or before any estimate", () => {
    const free = onramp({ totalFiatAmount: "25", fees: { currency: "USD", total: "0" } });
    expect(youPayCopy(t, { estimate: free, amount: "25", fiat: "USD" }, "en")).toEqual({
      value: "25.00 USD",
      aside: undefined,
    });
    expect(youPayCopy(t, { estimate: null, amount: "25", fiat: "USD" }, "en")).toEqual({
      value: "25.00 USD",
      aside: undefined,
    });
  });
});

describe("estimateRateCopy", () => {
  it("prices one unit of the crypto in the fiat", () => {
    expect(estimateRateCopy(t, estimate({}), "en")).toBe("1 SOL = 109.21 USD");
    expect(
      estimateRateCopy(t, estimate({ assetRail: "usdc.solana", exchangeRate: "0.998" }), "en")
    ).toBe("1 USDC = 0.998 USD");
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

describe("estimateFeeCopy", () => {
  it("splits the fees only when they are charged in different currencies", () => {
    expect(
      estimateFeeCopy(
        t,
        {
          currency: "USD",
          total: "4.00",
          provider: "3.99",
          providerCurrency: "USD",
          network: "0.01",
          networkCurrency: "SOL",
        },
        "en"
      )
    ).toBe(
      t("DashboardPayments.ramps.fees", {
        providerFee: "3.99",
        providerCurrency: "USD",
        networkFee: "0.01",
        networkCurrency: "SOL",
      })
    );
    expect(estimateFeeCopy(t, { currency: "USD", total: "3.99" }, "en")).toBe(
      t("DashboardPayments.ramps.fee", { amount: "3.99", currency: "USD" })
    );
  });

  it("says there are no fees for a zero total", () => {
    expect(estimateFeeCopy(t, { currency: "USD", total: "0.00" }, "en")).toBe(
      t("DashboardPayments.ramps.noFees")
    );
  });
});
