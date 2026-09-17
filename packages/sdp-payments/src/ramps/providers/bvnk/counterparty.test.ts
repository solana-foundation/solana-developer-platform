import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SdpPaymentsError } from "../../../errors";
import { countryField, parseCollectedFields } from "../../requirements";
import { isBvnkOfframpCurrency } from "./counterparty";

describe("country field options", () => {
  it("validates collected values against the offered subset", () => {
    const fields = [
      countryField({
        key: "taxResidenceCountryCode",
        label: "Tax residence country",
        required: true,
        options: ["US", "DE"],
      }),
    ];

    assert.deepEqual(parseCollectedFields(fields, { taxResidenceCountryCode: "DE" }, "message"), {
      taxResidenceCountryCode: "DE",
    });
    assert.throws(
      () => parseCollectedFields(fields, { taxResidenceCountryCode: "RU" }, "message"),
      SdpPaymentsError
    );
  });
});

describe("BVNK off-ramp currency", () => {
  it("accepts the settlement currencies", () => {
    assert.equal(isBvnkOfframpCurrency("USD"), true);
    assert.equal(isBvnkOfframpCurrency("EUR"), true);
    assert.equal(isBvnkOfframpCurrency("GBP"), false);
  });
});
