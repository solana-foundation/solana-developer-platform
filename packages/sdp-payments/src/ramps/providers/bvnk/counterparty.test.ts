import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBvnkContactRequest,
  buildBvnkCustomerRequest,
  bvnkOnrampFields,
} from "./counterparty";

const usCollectedData = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1815-12-10",
  email: "ada@example.com",
  "address.addressLine1": "1 Main Street",
  "address.city": "Austin",
  "address.postalCode": "78701",
  "address.countryCode": "US",
  "address.stateCode": "TX",
  "taxIdentification.number": "123-45-6789",
  "taxIdentification.taxResidenceCountryCode": "US",
  birthCountryCode: "GB",
  "cdd.employmentStatus": "SELF_EMPLOYED",
  "cdd.sourceOfFunds": "SALARY",
  "cdd.pepStatus": "NOT_PEP",
  "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
  "cdd.expectedMonthlyVolume.amount": "1000.50",
  "cdd.expectedMonthlyVolume.currency": "USD",
  "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
  "cdd.employmentIndustrySector": "INFORMATION",
};

describe("BVNK counterparty builders", () => {
  it("maps US identity and CDD fields into the v2 customer request", () => {
    const customer = buildBvnkCustomerRequest(usCollectedData);

    assert.deepEqual(customer, {
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        postalCode: "78701",
        countryCode: "US",
        stateCode: "TX",
      },
      dateOfBirth: "1815-12-10",
      firstName: "Ada",
      lastName: "Lovelace",
      birthCountryCode: "GB",
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

  it("only adds US conditional fields for US residence", () => {
    const usKeys = bvnkOnrampFields("US").map((field) => field.key);
    const gbKeys = bvnkOnrampFields("GB").map((field) => field.key);

    assert.equal(usKeys.includes("address.stateCode"), true);
    assert.equal(usKeys.includes("taxIdentification.number"), true);
    assert.equal(usKeys.includes("cdd.estimatedYearlyIncome"), true);
    assert.equal(gbKeys.includes("address.stateCode"), false);
    assert.equal(gbKeys.includes("taxIdentification.number"), false);
    assert.equal(gbKeys.includes("cdd.estimatedYearlyIncome"), false);
    assert.equal(
      bvnkOnrampFields("DE").some((field) => field.key === "nationality"),
      true
    );
  });

  it("builds the travel-rule contact without tax or CDD data", () => {
    assert.deepEqual(buildBvnkContactRequest(usCollectedData), {
      type: "INDIVIDUAL",
      relationshipType: "SELF_OWNED",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        postalCode: "78701",
        country: "US",
        region: "TX",
      },
    });
  });
});
