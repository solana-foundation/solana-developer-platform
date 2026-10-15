import { FIAT_PEG_CURRENCIES } from "@sdp/types/payment-rails";
import { describe, expect, it } from "vitest";
import { fiatCurrencyOptions } from "./fiat-currency-options";

describe("issuance peg currencies", () => {
  it("offers pegs regardless of ramp provider support", () => {
    expect(FIAT_PEG_CURRENCIES).toEqual(expect.arrayContaining(["JPY", "CNY", "KRW"]));
  });

  it("renders a picker option for every peg", () => {
    expect(fiatCurrencyOptions(FIAT_PEG_CURRENCIES)).toHaveLength(FIAT_PEG_CURRENCIES.length);
  });
});
