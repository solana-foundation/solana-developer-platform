import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import { SdpPaymentsError } from "../../../errors";
import { countryField, parseCollectedFields } from "../../requirements";
import { isBvnkOfframpCurrency } from "./counterparty";

function counterparty(): Counterparty {
  return {
    id: "cpty_123e4567-e89b-12d3-a456-426614174000",
    organizationId: "org_123",
    projectId: "proj_123",
    externalId: null,
    entityType: "individual",
    displayName: "Ada Lovelace",
    status: "active",
    createdBy: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

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
