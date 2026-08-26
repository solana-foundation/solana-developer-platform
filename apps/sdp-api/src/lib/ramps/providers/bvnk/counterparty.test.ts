import { SdpPaymentsError } from "@sdp/payments";
import {
  buildBvnkIndividualPayload,
  validateBvnkCounterparty,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import { normalizeBvnkStateCode } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";

const ONRAMP_REQUIREMENTS_OPTIONS = {
  country: "US",
  cryptoToken: "USDC_SOLANA",
  fiatCurrency: "USD",
  destinationWalletAddress: "dest",
} as const;

const BVNK_CDD_COLLECTED_DATA = {
  "address.line1": "1 Market St",
  "address.line2": "Suite 5",
  "address.city": "San Francisco",
  "address.postalCode": "94105",
  "address.subdivisionCode": "TX",
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
      collectedData: BVNK_CDD_COLLECTED_DATA,
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
      "address.line1",
      "address.line2",
      "address.city",
      "address.postalCode",
      "address.subdivisionCode",
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

  it("uses request country rather than stored identity to choose subdivision fields", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      country: "GB",
      providerData: {},
    });

    if (requirements.status !== "collect") {
      throw new Error("Expected collect requirements");
    }
    expect(requirements.fields.map((field) => field.key)).not.toContain("address.subdivisionCode");
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
    expect(() => normalizeBvnkStateCode("GB", "GB-ENG")).toThrow(SdpPaymentsError);
  });

  it("does not strip a prefix that does not match the country code", () => {
    expect(() => normalizeBvnkStateCode("US", "XX-TX")).toThrow(SdpPaymentsError);
  });

  it("throws for a 1-character code", () => {
    expect(() => normalizeBvnkStateCode("US", "X")).toThrow(SdpPaymentsError);
  });
});

describe("buildBvnkIndividualPayload", () => {
  it("builds the address from collected fields plus request country", () => {
    const payload = buildBvnkIndividualPayload(
      counterpartyRow(),
      BVNK_CDD_COLLECTED_DATA,
      "USD",
      "US"
    );

    expect(payload).toMatchObject({
      address: {
        addressLine1: "1 Market St",
        addressLine2: "Suite 5",
        city: "San Francisco",
        postalCode: "94105",
        countryCode: "US",
        stateCode: "TX",
      },
    });
  });
});
