import type { MuralAccountResolution } from "@sdp/payments/ramps/providers/mural/provider-data";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { muralOnrampQuote } from "./mural";

function account(overrides?: Partial<MuralAccountResolution>): MuralAccountResolution {
  return {
    id: "acct_1",
    isApiEnabled: true,
    status: "ACTIVE",
    payinMethods: [
      {
        status: "ACTIVATED",
        currency: "EUR",
        payinRailDetails: {
          type: "eur",
          currency: "EUR",
          payinRail: "SEPA",
          iban: "DE95276967022668913124",
          bic: "DEUTDE58587",
          accountHolderName: "SDP",
        },
      },
    ],
    ...overrides,
  };
}

describe("muralOnrampQuote", () => {
  it("builds payin instructions from the matching activated payin method", () => {
    const quote = muralOnrampQuote({ account: account(), fiatCurrency: "EUR" });
    expect(quote).toEqual({
      provider: "mural",
      id: expect.stringMatching(/^ramp_/),
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [
        {
          provider: "mural",
          fiatCurrency: "EUR",
          payinRails: ["SEPA"],
          bankDetails: {
            iban: "DE95276967022668913124",
            bic: "DEUTDE58587",
            accountHolderName: "SDP",
          },
        },
      ],
    });
  });

  it("throws when fiatCurrency is missing", () => {
    expect(() => muralOnrampQuote({ account: account() })).toThrow(AppError);
  });

  it("throws when no activated payin method matches the fiat currency", () => {
    expect(() => muralOnrampQuote({ account: account(), fiatCurrency: "USD" })).toThrow(AppError);
  });
});
