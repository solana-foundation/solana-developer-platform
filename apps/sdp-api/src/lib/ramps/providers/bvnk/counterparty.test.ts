import { SdpPaymentsError } from "@sdp/payments";
import {
  buildBvnkCustomerRequest,
  validateBvnkCounterparty,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import {
  BVNK_RESIDENCE_FIELDS,
  BVNK_US_MTL_STATES,
  bvnkOnrampFields,
} from "@sdp/payments/ramps/providers/bvnk/requirements";
import { countryField, parseCollectedFields } from "@sdp/payments/ramps/requirements";
import type { Counterparty, CountryCode } from "@sdp/types";
import { describe, expect, it } from "vitest";

const ONRAMP_REQUIREMENTS_OPTIONS = {
  cryptoToken: "USDC_SOLANA",
  fiatCurrency: "USD",
  destinationWalletAddress: "dest",
} as const;

function counterparty(overrides?: Partial<Counterparty>): Counterparty {
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
    ...overrides,
  };
}

const US_COLLECTED_DATA = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1815-12-10",
  email: "ada@example.com",
  "address.addressLine1": "1 Main Street",
  "address.city": "Jefferson City",
  "address.stateCode": "MO",
  "address.postalCode": "65101",
  "address.countryCode": "US",
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
} as const;

describe("validateBvnkCounterparty", () => {
  it("collects only the residence country for a new BVNK customer", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {},
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "collect_counterparty_residence",
      fields: BVNK_RESIDENCE_FIELDS,
    });
    if (requirements.status === "collect_counterparty_residence") {
      expect(requirements.fields).toHaveLength(1);
      expect(requirements.fields[0].key).toBe("taxIdentification.taxResidenceCountryCode");
    }
  });
});

describe("bvnkOnrampFields", () => {
  it("adds the US-only fields for US counterparties", () => {
    const flatKeys = (countryCode: CountryCode) =>
      bvnkOnrampFields(countryCode).flatMap((field) =>
        field.kind === "address" ? field.fields.map((nested) => nested.key) : [field.key]
      );
    const usKeys = flatKeys("US");
    const baseKeys = flatKeys("GB");

    expect(usKeys).toContain("address.stateCode");
    expect(baseKeys).not.toContain("address.stateCode");
    expect(usKeys).toEqual(expect.arrayContaining(baseKeys));
  });

  it("nests the 40-option MTL state select inside the US address group", () => {
    const usAddressGroup = bvnkOnrampFields("US").find((field) => field.kind === "address");
    expect(usAddressGroup?.kind).toBe("address");
    const stateSelect = (usAddressGroup?.kind === "address" ? usAddressGroup.fields : []).find(
      (part) => part.key === "address.stateCode"
    );
    expect(stateSelect?.kind).toBe("select");
    const optionValues = (stateSelect?.kind === "select" ? stateSelect.options : []).map(
      (option) => option.value
    );
    expect(optionValues).toEqual(Object.keys(BVNK_US_MTL_STATES));
    expect(optionValues).toHaveLength(40);
    expect(optionValues).not.toContain("TX");
    expect(optionValues).not.toContain("NY");
  });

  it("omits the state select from non-US address groups", () => {
    const deAddressGroup = bvnkOnrampFields("DE").find((field) => field.kind === "address");
    expect(deAddressGroup?.kind).toBe("address");
    const partKeys = (deAddressGroup?.kind === "address" ? deAddressGroup.fields : []).map(
      (part) => part.key
    );
    expect(partKeys).not.toContain("address.stateCode");
  });
});

describe("buildBvnkCustomerRequest", () => {
  it("accepts an MTL state code and builds the US v2 individual", () => {
    expect(buildBvnkCustomerRequest(US_COLLECTED_DATA, "US")).toEqual({
      address: {
        addressLine1: "1 Main Street",
        city: "Jefferson City",
        postalCode: "65101",
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

  it("rejects a state code outside the MTL set", () => {
    expect(() =>
      buildBvnkCustomerRequest({ ...US_COLLECTED_DATA, "address.stateCode": "TX" }, "US")
    ).toThrowError(SdpPaymentsError);
    expect(() =>
      buildBvnkCustomerRequest({ ...US_COLLECTED_DATA, "address.stateCode": "NY" }, "US")
    ).toThrowError(SdpPaymentsError);
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

    expect(customer).toEqual({
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

    expect(parseCollectedFields(fields, { taxResidenceCountryCode: "DE" }, "message")).toEqual({
      taxResidenceCountryCode: "DE",
    });
    expect(() =>
      parseCollectedFields(fields, { taxResidenceCountryCode: "RU" }, "message")
    ).toThrowError(SdpPaymentsError);
  });
});
