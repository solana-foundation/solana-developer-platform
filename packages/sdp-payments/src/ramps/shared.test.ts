import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { isActiveIso4217CurrencyCode } from "./shared";

describe("isActiveIso4217CurrencyCode", () => {
  it("accepts currencies in circulation, including the supranational ones", () => {
    // The X-prefixed codes are shared currencies, not placeholders: XOF and XAF
    // are the two CFA francs, XCD the East Caribbean dollar, XPF the CFP franc.
    for (const code of ["USD", "EUR", "MXN", "XAF", "XCD", "XOF", "XPF", "SLE", "XCG"]) {
      assert.equal(isActiveIso4217CurrencyCode(code), true, code);
    }
  });

  it("rejects codes ICU still reports after the currency left circulation", () => {
    // Each was succeeded: ANG by XCG, BGN and HRK by EUR, CUC by CUP, SLL by
    // SLE, SVC by USD, ZWL by ZWG. ICU keeps reporting them, so a provider
    // catalogue that still lists one would otherwise reach the currency picker.
    for (const code of ["ANG", "BGN", "CUC", "HRK", "SLL", "SVC", "ZWL"]) {
      assert.equal(isActiveIso4217CurrencyCode(code), false, code);
    }
  });

  it("rejects units of account that were never tender", () => {
    assert.equal(isActiveIso4217CurrencyCode("XDR"), false);
    assert.equal(isActiveIso4217CurrencyCode("XSU"), false);
  });

  it("normalises case and surrounding whitespace", () => {
    assert.equal(isActiveIso4217CurrencyCode(" usd "), true);
    assert.equal(isActiveIso4217CurrencyCode("eur"), true);
  });

  it("rejects anything that is not a three-letter code", () => {
    for (const code of ["", "US", "USDC", "US1", "usdc.solana"]) {
      assert.equal(isActiveIso4217CurrencyCode(code), false, JSON.stringify(code));
    }
  });
});

describe("RAMP_FIAT_CURRENCIES", () => {
  it("offers only currencies that can still be transacted", () => {
    // The generated union is what the dashboard pickers list. Provider
    // catalogues carry retired codes for years, so this guards the filter that
    // keeps them out of the emitted types.
    const retired = RAMP_FIAT_CURRENCIES.filter((code) => !isActiveIso4217CurrencyCode(code));
    assert.deepEqual(retired, []);
  });
});
