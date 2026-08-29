import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BVNK_INDIVIDUAL_FIELD_ALLOWLIST } from "@sdp/types/partner-intake";
import { SdpPaymentsError } from "../errors";
import { enforcePartnerFieldAllowlist } from "./partner-egress";

/** The shape `buildBvnkIndividualPayload` produced for a US counterparty. */
function bvnkIndividual(): Record<string, unknown> {
  return {
    description: "SDP onramp",
    firstName: "Ada",
    lastName: "Lovelace",
    dateOfBirth: "1815-12-10",
    emailAddress: "ada@example.com",
    nationality: "GB",
    birthCountryCode: "GB",
    taxIdentification: { number: "123456789", taxResidenceCountryCode: "US" },
    address: {
      addressLine1: "1 Analytical Way",
      city: "San Francisco",
      postalCode: "94103",
      countryCode: "US",
      stateCode: "CA",
    },
    cdd: {
      employmentStatus: "employed",
      sourceOfFunds: "salary",
      pepStatus: "none",
      intendedUseOfAccount: "personal",
      expectedMonthlyVolume: { amount: "1000", currency: "USD" },
      estimatedYearlyIncome: "100000_250000",
      employmentIndustrySector: "technology",
    },
  };
}

describe("enforcePartnerFieldAllowlist", () => {
  it("passes the BVNK individual payload the integration actually builds", () => {
    const payload = bvnkIndividual();

    assert.equal(enforcePartnerFieldAllowlist("ramps", "bvnk", payload), payload);
  });

  it("refuses a top-level field the register does not list", () => {
    const payload = { ...bvnkIndividual(), passportNumber: "X1234567" };

    assert.throws(
      () => enforcePartnerFieldAllowlist("ramps", "bvnk", payload),
      (error: unknown) =>
        error instanceof SdpPaymentsError &&
        error.code === "INTERNAL_ERROR" &&
        error.message.includes("passportNumber")
    );
  });

  it("refuses an undeclared field nested inside a declared parent", () => {
    const payload = bvnkIndividual();
    (payload.taxIdentification as Record<string, unknown>).issuingAuthority = "IRS";

    assert.throws(
      () => enforcePartnerFieldAllowlist("ramps", "bvnk", payload),
      (error: unknown) =>
        error instanceof SdpPaymentsError &&
        error.message.includes("taxIdentification.issuingAuthority")
    );
  });

  /**
   * The refusal is the diagnostic, so it must not become the leak it exists to
   * prevent. Paths identify the mismatch; values never appear.
   */
  it("names the offending path and never its value", () => {
    const payload = { ...bvnkIndividual(), motherMaidenName: "Byron" };

    assert.throws(
      () => enforcePartnerFieldAllowlist("ramps", "bvnk", payload),
      (error: unknown) =>
        error instanceof SdpPaymentsError &&
        error.message.includes("motherMaidenName") &&
        !error.message.includes("Byron")
    );
  });

  it("accepts a partial payload: an allowlist is a ceiling, not a requirement", () => {
    const payload = { firstName: "Ada", lastName: "Lovelace" };

    assert.equal(enforcePartnerFieldAllowlist("ramps", "bvnk", payload), payload);
  });

  /**
   * `undefined` is how the builder spells "omit this"; it never reaches the
   * wire, so treating it as a present field would refuse valid payloads.
   */
  it("ignores keys whose value is undefined", () => {
    const payload = { firstName: "Ada", middleName: undefined };

    assert.equal(enforcePartnerFieldAllowlist("ramps", "bvnk", payload), payload);
  });

  /**
   * The guard rail on the guard rail: calling this for a partner whose register
   * entry does not declare a forwarded payload means someone started sending
   * identity fields without recording where they go.
   */
  it("refuses a partner that declares no forwarded personal-data payload", () => {
    assert.throws(
      () => enforcePartnerFieldAllowlist("ramps", "mural", { firstName: "Ada" }),
      (error: unknown) =>
        error instanceof SdpPaymentsError && error.message.includes("partner intake register")
    );
  });

  it("refuses an unregistered provider id outright", () => {
    assert.throws(
      () => enforcePartnerFieldAllowlist("ramps", "not-a-provider", { firstName: "Ada" }),
      SdpPaymentsError
    );
  });

  /**
   * The allowlist is recovered from the payload builder that #1507 removed. If
   * the two ever disagree the enforcement silently stops covering a field, so
   * pin the identity fields that carry the most weight.
   */
  it("covers the government-id and CDD fields BVNK requires", () => {
    for (const path of [
      "taxIdentification.number",
      "nationality",
      "birthCountryCode",
      "cdd.pepStatus",
      "cdd.sourceOfFunds",
    ]) {
      assert.ok(
        (BVNK_INDIVIDUAL_FIELD_ALLOWLIST as readonly string[]).includes(path),
        `${path} missing from the BVNK allowlist`
      );
    }
  });
});
