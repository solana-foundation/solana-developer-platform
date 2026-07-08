import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError } from "@/lib/errors";
import { buildBvnkIndividualPayload, validateBvnkCounterparty } from "./counterparty";
import { normalizeBvnkStateCode } from "./provider-data";

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
    expect(() => normalizeBvnkStateCode("GB", "GB-ENG")).toThrowError(AppError);
  });

  it("does not strip a prefix that does not match the country code", () => {
    expect(() => normalizeBvnkStateCode("US", "XX-TX")).toThrowError(AppError);
  });

  it("throws for a 1-character code", () => {
    expect(() => normalizeBvnkStateCode("US", "X")).toThrowError(AppError);
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
