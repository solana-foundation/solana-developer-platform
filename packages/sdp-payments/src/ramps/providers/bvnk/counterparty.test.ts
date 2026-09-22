import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty, CountryCode } from "@sdp/types";
import { SdpPaymentsError } from "../../../errors";
import { countryField, parseCollectedFields } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  buildBvnkCustomerRequest,
  parseBvnkResidenceCountry,
  validateBvnkCounterparty,
} from "./counterparty";
import { BVNK_RESIDENCE_FIELDS, BVNK_US_MTL_STATES, bvnkOnrampFields } from "./requirements";

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
    const flatKeys = (countryCode: CountryCode) =>
      bvnkOnrampFields(countryCode).flatMap((field) =>
        field.kind === "address" ? field.fields.map((nested) => nested.key) : [field.key]
      );
    const usKeys = flatKeys("US");
    const gbKeys = flatKeys("GB");

    assert.equal(usKeys.includes("address.stateCode"), true);
    assert.equal(usKeys.includes("taxIdentification.number"), true);
    assert.equal(usKeys.includes("cdd.estimatedYearlyIncome"), true);
    assert.equal(usKeys.includes("taxIdentification.taxResidenceCountryCode"), false);
    assert.equal(gbKeys.includes("address.stateCode"), false);
    assert.equal(gbKeys.includes("taxIdentification.number"), true);
    assert.equal(gbKeys.includes("cdd.estimatedYearlyIncome"), false);
    for (const key of gbKeys) {
      assert.equal(usKeys.includes(key), true);
    }
    assert.equal(
      bvnkOnrampFields("DE").some((field) => field.key === "nationality"),
      true
    );
  });

  it("nests the 40-option MTL state select inside the US address group", () => {
    const usAddressGroup = bvnkOnrampFields("US").find((field) => field.kind === "address");
    assert.equal(usAddressGroup?.kind, "address");
    const stateSelect = (usAddressGroup?.kind === "address" ? usAddressGroup.fields : []).find(
      (part) => part.key === "address.stateCode"
    );
    assert.equal(stateSelect?.kind, "select");
    const optionValues = (stateSelect?.kind === "select" ? stateSelect.options : []).map(
      (option) => option.value
    );
    assert.deepEqual(optionValues, Object.keys(BVNK_US_MTL_STATES));
    assert.equal(optionValues.length, 40);
    assert.equal(optionValues.includes("TX"), false);
    assert.equal(optionValues.includes("NY"), false);
  });

  it("accepts an MTL state code and rejects one outside the MTL set", () => {
    const customer = buildBvnkCustomerRequest(usCollectedData, "US");

    assert.equal(customer.address.stateCode, "MO");
    assert.throws(
      () => buildBvnkCustomerRequest({ ...usCollectedData, "address.stateCode": "TX" }, "US"),
      SdpPaymentsError
    );
    assert.throws(
      () => buildBvnkCustomerRequest({ ...usCollectedData, "address.stateCode": "NY" }, "US"),
      SdpPaymentsError
    );
  });

  it("builds the EU v2 individual without US extras", () => {
    const customer = buildBvnkCustomerRequest(
      {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.addressLine1": "1 Main Street",
        "address.city": "Berlin",
        "address.postalCode": "10115",
        "address.countryCode": "DE",
        birthCountryCode: "GB",
        nationality: "GB",
        "cdd.employmentStatus": "SELF_EMPLOYED",
        "cdd.sourceOfFunds": "SALARY",
        "cdd.pepStatus": "NOT_PEP",
        "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
        "cdd.expectedMonthlyVolume.amount": "1000.50",
        "cdd.expectedMonthlyVolume.currency": "EUR",
        "taxIdentification.number": "12345678901",
      },
      "DE"
    );

    assert.deepEqual(customer, {
      address: {
        addressLine1: "1 Main Street",
        city: "Berlin",
        postalCode: "10115",
        countryCode: "DE",
      },
      dateOfBirth: "1815-12-10",
      firstName: "Ada",
      lastName: "Lovelace",
      birthCountryCode: "GB",
      nationality: "GB",
      emailAddress: "ada@example.com",
      taxIdentification: { number: "12345678901", taxResidenceCountryCode: "DE" },
      cdd: {
        employmentStatus: "SELF_EMPLOYED",
        sourceOfFunds: "SALARY",
        pepStatus: "NOT_PEP",
        intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
        expectedMonthlyVolume: { amount: "1000.50", currency: "EUR" },
      },
    });
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

  it("runs the same residence gate for the off-ramp direction", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "USD",
    });

    assert.deepEqual(requirements, {
      provider: "bvnk",
      direction: "offramp",
      status: "collect_counterparty_residence",
      fields: BVNK_RESIDENCE_FIELDS,
    });
  });

  it("rejects any non-USD fiat before the residence gate, both directions", () => {
    for (const direction of ["onramp", "offramp"] as const) {
      assert.deepEqual(
        validateBvnkCounterparty(counterparty(), {
          direction,
          providerData: {},
          fiatCurrency: "EUR",
        }),
        {
          provider: "bvnk",
          direction,
          status: "unsupported",
          reason: "BVNK supports USD only.",
        }
      );
    }
  });

  it("rejects non-individual counterparties in both directions", () => {
    const business: Counterparty = { ...counterparty(), entityType: "business" };
    for (const direction of ["onramp", "offramp"] as const) {
      assert.deepEqual(
        validateBvnkCounterparty(business, { direction, providerData: {}, fiatCurrency: "USD" }),
        {
          provider: "bvnk",
          direction,
          status: "unsupported",
          reason: "BVNK supports individual counterparties only.",
        }
      );
    }
  });
});

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
