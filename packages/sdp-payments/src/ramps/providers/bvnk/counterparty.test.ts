import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  buildBvnkCustomerRequest,
  parseBvnkResidenceCountry,
  validateBvnkCounterparty,
} from "./counterparty";
import { BVNK_RESIDENCE_FIELDS, bvnkOnrampFields } from "./requirements";

const usCollectedData = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1815-12-10",
  email: "ada@example.com",
  "address.addressLine1": "1 Main Street",
  "address.city": "Austin",
  "address.postalCode": "78701",
  "address.countryCode": "US",
  "address.stateCode": "MO",
  "taxIdentification.number": "123-45-6789",
  birthCountryCode: "GB",
  nationality: "GB",
  "cdd.employmentStatus": "SELF_EMPLOYED",
  "cdd.sourceOfFunds": "SALARY",
  "cdd.pepStatus": "NOT_PEP",
  "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
  "cdd.expectedMonthlyVolume.amount": "1000.50",
  "cdd.expectedMonthlyVolume.currency": "USD",
  "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
  "cdd.employmentIndustrySector": "INFORMATION",
};

function counterparty(): Counterparty {
  return {
    id: "cp_123",
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

describe("BVNK counterparty builders", () => {
  it("maps US identity and CDD fields into the v2 customer request", () => {
    const customer = buildBvnkCustomerRequest(usCollectedData, "US");

    assert.deepEqual(customer, {
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        postalCode: "78701",
        countryCode: "US",
        stateCode: "MO",
      },
      dateOfBirth: "1815-12-10",
      firstName: "Ada",
      lastName: "Lovelace",
      birthCountryCode: "GB",
      nationality: "GB",
      emailAddress: "ada@example.com",
      taxIdentification: { number: "123-45-6789", taxResidenceCountryCode: "US" },
      cdd: {
        employmentStatus: "SELF_EMPLOYED",
        sourceOfFunds: "SALARY",
        pepStatus: "NOT_PEP",
        intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
        expectedMonthlyVolume: { amount: "1000.50", currency: "USD" },
        estimatedYearlyIncome: "INCOME_100K_TO_250K",
        employmentIndustrySector: "INFORMATION",
      },
    });
  });

  it("reads the residence from the parameter, never from collected data", () => {
    const customer = buildBvnkCustomerRequest(
      { ...usCollectedData, "taxIdentification.taxResidenceCountryCode": "RU" },
      "US"
    );

    assert.equal(customer.taxIdentification?.taxResidenceCountryCode, "US");
    assert.equal(customer.taxIdentification?.number, "123-45-6789");
  });

  it("only adds US conditional fields for US residence", () => {
    const usKeys = bvnkOnrampFields("US").map((field) => field.key);
    const gbKeys = bvnkOnrampFields("GB").map((field) => field.key);

    assert.equal(usKeys.includes("address.stateCode"), true);
    assert.equal(usKeys.includes("taxIdentification.number"), true);
    assert.equal(usKeys.includes("cdd.estimatedYearlyIncome"), true);
    assert.equal(usKeys.includes("taxIdentification.taxResidenceCountryCode"), false);
    assert.equal(gbKeys.includes("address.stateCode"), false);
    assert.equal(gbKeys.includes("taxIdentification.number"), true);
    assert.equal(gbKeys.includes("cdd.estimatedYearlyIncome"), false);
    assert.equal(
      bvnkOnrampFields("DE").some((field) => field.key === "nationality"),
      true
    );
  });
});

describe("parseBvnkResidenceCountry", () => {
  it("accepts an onboardable country", () => {
    assert.equal(
      parseBvnkResidenceCountry({ "taxIdentification.taxResidenceCountryCode": "US" }),
      "US"
    );
  });

  it("rejects a prohibited country", () => {
    assert.throws(() =>
      parseBvnkResidenceCountry({ "taxIdentification.taxResidenceCountryCode": "RU" })
    );
  });
});

describe("validateBvnkCounterparty", () => {
  it("collects only the residence country when no customer link exists", () => {
    const options: ValidateCounterpartyOptions = {
      direction: "onramp",
      providerData: {},
    };
    const requirements = validateBvnkCounterparty(counterparty(), options);

    assert.deepEqual(requirements, {
      provider: "bvnk",
      direction: "onramp",
      status: "collect_counterparty_residence",
      fields: BVNK_RESIDENCE_FIELDS,
    });
  });
});
