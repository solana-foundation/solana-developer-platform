import { SdpPaymentsError } from "@sdp/payments";
import {
  buildBvnkCompanyPayload,
  buildBvnkIndividualPayload,
  validateBvnkCounterparty,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import { normalizeBvnkStateCode } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";

const ONRAMP_REQUIREMENTS_OPTIONS = {
  cryptoToken: "USDC_SOLANA",
  fiatCurrency: "USD",
  destinationWalletAddress: "dest",
} as const;

const BVNK_CDD_COLLECTED_DATA = {
  "taxIdentification.number": "123-45-6789",
  "taxIdentification.taxResidenceCountryCode": "US",
  nationality: "US",
  birthCountryCode: "US",
  "cdd.employmentStatus": "SALARIED",
  "cdd.sourceOfFunds": "SALARY",
  "cdd.pepStatus": "NOT_PEP",
  "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
  "cdd.expectedMonthlyVolume.amount": "1000",
  "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
  "cdd.employmentIndustrySector": "INFORMATION",
} as const;

type IndividualCounterparty = Extract<Counterparty, { entityType: "individual" }>;
type IndividualCounterpartyRow = Extract<CounterpartyRow, { entity_type: "individual" }>;

function counterparty(overrides?: Partial<IndividualCounterparty>): IndividualCounterparty {
  return {
    id: "cp_123",
    organizationId: "org_123",
    projectId: "proj_123",
    externalId: null,
    entityType: "individual",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    identity: {
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1990-01-15",
      phone: "+14155551234",
      address: {
        line1: "1 Market St",
        city: "San Francisco",
        countryCode: "US",
        subdivisionCode: "CA",
      },
    },
    status: "active",
    createdBy: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function counterpartyRow(
  overrides?: Partial<IndividualCounterpartyRow>
): IndividualCounterpartyRow {
  return {
    id: "cp_123",
    organization_id: "org_123",
    project_id: "proj_123",
    external_id: null,
    entity_type: "individual",
    display_name: "Ada Lovelace",
    email: "ada@example.com",
    identity: counterparty().identity,
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("validateBvnkCounterparty", () => {
  it("does not report ready just because the BVNK customer exists", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {
        bvnk: {
          customer: { customerReference: "cust_123", status: "VERIFIED" },
        },
      },
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "funding_account_provisioning",
    });
  });

  it("collects BVNK CDD fields instead of reading them from stored counterparty identity", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {},
    });

    expect(requirements.status).toBe("collect");
    expect(requirements).toMatchObject({ provider: "bvnk", direction: "onramp" });
    if (requirements.status !== "collect") throw new Error("Expected collect requirements");
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "taxIdentification.number",
      "taxIdentification.taxResidenceCountryCode",
      "nationality",
      "birthCountryCode",
      "cdd.employmentStatus",
      "cdd.sourceOfFunds",
      "cdd.pepStatus",
      "cdd.intendedUseOfAccount",
      "cdd.expectedMonthlyVolume.amount",
      "cdd.estimatedYearlyIncome",
      "cdd.employmentIndustrySector",
    ]);
  });
});

describe("normalizeBvnkStateCode", () => {
  it("strips a matching ISO 3166-2 country prefix", () => {
    expect(normalizeBvnkStateCode("US", "US-TX")).toBe("TX");
  });

  it("returns an already-bare code unchanged", () => {
    expect(normalizeBvnkStateCode("US", "TX")).toBe("TX");
  });

  it("uppercases a lowercase code", () => {
    expect(normalizeBvnkStateCode("US", "tx")).toBe("TX");
  });

  it("throws when the stripped remainder is not 2 characters", () => {
    expect(() => normalizeBvnkStateCode("GB", "GB-ENG")).toThrowError(SdpPaymentsError);
  });

  it("does not strip a prefix that does not match the country code", () => {
    expect(() => normalizeBvnkStateCode("US", "XX-TX")).toThrowError(SdpPaymentsError);
  });

  it("throws for a 1-character code", () => {
    expect(() => normalizeBvnkStateCode("US", "X")).toThrowError(SdpPaymentsError);
  });
});

describe("buildBvnkIndividualPayload", () => {
  it("normalizes an ISO-prefixed stored subdivision code to BVNK's bare stateCode", () => {
    const row = counterpartyRow({
      identity: {
        ...counterparty().identity,
        address: {
          line1: "1 Market St",
          city: "San Francisco",
          countryCode: "US",
          subdivisionCode: "US-TX",
        },
      },
    });

    const payload = buildBvnkIndividualPayload(row, BVNK_CDD_COLLECTED_DATA, "USD");

    expect(payload.address).toMatchObject({ countryCode: "US", stateCode: "TX" });
  });
});

type BusinessCounterparty = Extract<Counterparty, { entityType: "business" }>;
type BusinessCounterpartyRow = Extract<CounterpartyRow, { entity_type: "business" }>;

const BVNK_COMPANY_COLLECTED_DATA = {
  "company.entityType": "CORPORATION",
  "company.registrationNumber": "HRB 123456",
  "company.taxIdentification.number": "DE123456789",
  "company.taxIdentification.taxResidenceCountryCode": "DE",
  "company.incorporationDate": "2019-01-15",
  "company.businessOperationsStartDate": "2019-02-01",
  "company.businessProfile.naicsCode": "5239",
  "company.businessProfile.website": "https://krause-fintech.example.com",
  "company.businessProfile.monthlyExpectedVolumes": "FROM_100K_TO_1M",
  "company.businessProfile.sourceOfFunds": "COMMERCIAL_ACTIVITIES",
  "company.businessProfile.intendedUseOfAccount": "SUPPLIER_VENDOR_PAYMENTS",
  "company.businessProfile.isRegulated": "false",
  "associate.firstName": "Freya",
  "associate.lastName": "Krause",
  "associate.dateOfBirth": "1982-03-24",
  "associate.nationality": "DE",
  "associate.birthCountryCode": "DE",
  "associate.emailAddress": "freya@krause-fintech.example.com",
  "associate.taxIdentification.number": "21/815/08150",
  "associate.taxIdentification.taxResidenceCountryCode": "DE",
  "associate.ownership.percentage": "100",
} as const;

function businessCounterparty(overrides?: Partial<BusinessCounterparty>): BusinessCounterparty {
  return {
    id: "cp_456",
    organizationId: "org_123",
    projectId: "proj_123",
    externalId: null,
    entityType: "business",
    displayName: "Krause Fintech GmbH",
    email: "ops@krause-fintech.example.com",
    identity: {
      address: {
        line1: "Heidestrasse 19",
        city: "Cologne",
        postalCode: "51247",
        countryCode: "DE",
      },
    },
    status: "active",
    createdBy: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function businessCounterpartyRow(
  overrides?: Partial<BusinessCounterpartyRow>
): BusinessCounterpartyRow {
  return {
    id: "cp_456",
    organization_id: "org_123",
    project_id: "proj_123",
    external_id: null,
    entity_type: "business",
    display_name: "Krause Fintech GmbH",
    email: "ops@krause-fintech.example.com",
    identity: businessCounterparty().identity,
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("validateBvnkCounterparty (business)", () => {
  it("collects the company + associate fields when no BVNK customer exists", () => {
    const requirements = validateBvnkCounterparty(businessCounterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {},
    });

    expect(requirements).toMatchObject({ provider: "bvnk", direction: "onramp" });
    if (requirements.status !== "collect") throw new Error("Expected collect requirements");
    expect(requirements.fields.map((field) => field.key)).toContain("company.entityType");
    expect(requirements.fields.map((field) => field.key)).toContain(
      "associate.ownership.percentage"
    );
  });

  it("surfaces the authenticatedLink for an INFO_REQUIRED v2 customer", () => {
    const requirements = validateBvnkCounterparty(businessCounterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {
        bvnk: {
          customer: {
            customerReference: "v2-uuid",
            status: "INFO_REQUIRED",
            verificationUrl: "https://onboarding.example.com/link",
            apiVersion: "v2",
          },
        },
      },
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://onboarding.example.com/link",
    });
  });

  it("reports customer_verifying while the v2 authenticatedLink is still being minted", () => {
    for (const status of ["INFO_REQUIRED", "NOT_STARTED"]) {
      const requirements = validateBvnkCounterparty(businessCounterparty(), {
        direction: "onramp",
        ...ONRAMP_REQUIREMENTS_OPTIONS,
        providerData: {
          bvnk: { customer: { customerReference: "v2-uuid", status, apiVersion: "v2" } },
        },
      });

      expect(requirements).toEqual({
        provider: "bvnk",
        direction: "onramp",
        status: "customer_verifying",
      });
    }
  });

  it("proceeds to funding provisioning once the v2 customer is VERIFIED", () => {
    const requirements = validateBvnkCounterparty(businessCounterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {
        bvnk: {
          customer: { customerReference: "v2-uuid", status: "VERIFIED", apiVersion: "v2" },
        },
      },
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "funding_account_provisioning",
    });
  });
});

describe("buildBvnkCompanyPayload", () => {
  it("builds the full v2 company payload from stored identity and collected fields", () => {
    const payload = buildBvnkCompanyPayload(businessCounterpartyRow(), BVNK_COMPANY_COLLECTED_DATA);

    const companyAddress = {
      addressLine1: "Heidestrasse 19",
      city: "Cologne",
      postalCode: "51247",
      countryCode: "DE",
    };
    expect(payload).toEqual({
      name: "Krause Fintech GmbH",
      entityType: "CORPORATION",
      taxIdentification: { number: "DE123456789", taxResidenceCountryCode: "DE" },
      registrationNumber: "HRB 123456",
      incorporationDate: "2019-01-15",
      businessOperationsStartDate: "2019-02-01",
      address: companyAddress,
      isOperationalAddressDifferent: false,
      businessProfile: {
        naicsCode: "5239",
        website: "https://krause-fintech.example.com",
        monthlyExpectedVolumes: "FROM_100K_TO_1M",
        intendedUseOfAccount: "SUPPLIER_VENDOR_PAYMENTS",
        isRegulated: false,
        sourceOfFunds: "COMMERCIAL_ACTIVITIES",
      },
      associates: [
        {
          person: {
            firstName: "Freya",
            lastName: "Krause",
            dateOfBirth: "1982-03-24",
            nationality: "DE",
            birthCountryCode: "DE",
            address: companyAddress,
            contactInfo: { emailAddress: "freya@krause-fintech.example.com" },
            taxIdentification: { number: "21/815/08150", taxResidenceCountryCode: "DE" },
          },
          titles: ["UBO", "DIRECTOR", "SIGNATORY", "ACCOUNT_REPRESENTATIVE"],
          ownership: { percentage: "100", type: "DIRECT" },
        },
      ],
    });
  });

  it("throws BAD_REQUEST when collected fields are missing or invalid", () => {
    const { "company.entityType": _omitted, ...incomplete } = BVNK_COMPANY_COLLECTED_DATA;

    expect(() => buildBvnkCompanyPayload(businessCounterpartyRow(), incomplete)).toThrowError(
      SdpPaymentsError
    );
    expect(() => buildBvnkCompanyPayload(businessCounterpartyRow(), undefined)).toThrowError(
      SdpPaymentsError
    );
  });

  it("throws for an individual counterparty", () => {
    expect(() =>
      buildBvnkCompanyPayload(counterpartyRow(), BVNK_COMPANY_COLLECTED_DATA)
    ).toThrowError(SdpPaymentsError);
  });
});
