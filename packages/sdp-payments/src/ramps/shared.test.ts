import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import {
  isActiveIso4217CurrencyCode,
  isPaymentTransferId,
  PAYMENT_TRANSFER_ID_PREFIX,
  paymentTransferUuid,
} from "./shared";

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

const TRANSFER_UUID = "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const TRANSFER_ID = `xfr_${TRANSFER_UUID}`;

describe("isPaymentTransferId", () => {
  it("accepts an SDP transfer id with a UUID", () => {
    assert.equal(PAYMENT_TRANSFER_ID_PREFIX, "xfr_");
    assert.equal(isPaymentTransferId(TRANSFER_ID), true);
  });

  it("rejects malformed ids and bare UUIDs", () => {
    for (const id of [
      "",
      "xfr_nope",
      TRANSFER_UUID,
      `other_${TRANSFER_UUID}`,
      `${TRANSFER_ID}_extra`,
    ]) {
      assert.equal(isPaymentTransferId(id), false, id);
    }
  });
});

describe("paymentTransferUuid", () => {
  it("returns the UUID without the transfer prefix", () => {
    assert.equal(paymentTransferUuid(TRANSFER_ID), TRANSFER_UUID);
  });

  for (const id of ["xfr_nope", TRANSFER_UUID]) {
    it(`rejects ${id}`, () => {
      assert.throws(() => paymentTransferUuid(id), /Not an SDP payment transfer id/);
    });
  }
});
