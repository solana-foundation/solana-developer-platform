import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError } from "@/lib/errors";
import {
  buildBvnkIndividualPayload,
  bvnkCounterpartyRequirements,
  normalizeBvnkStateCode,
} from "./bvnk";

function counterparty(overrides?: Partial<Counterparty>): Counterparty {
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
      address: {
        line1: "1 Market St",
        city: "San Francisco",
        countryCode: "US",
        subdivisionCode: "CA",
      },
      compliance: {
        taxIdentification: { number: "123-45-6789", residenceCountryCode: "US" },
        nationality: "US",
        birthCountryCode: "US",
        cdd: {
          employmentStatus: "SALARIED",
          sourceOfFunds: "SALARY",
          pepStatus: "NOT_PEP",
          intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
          expectedMonthlyVolume: { amount: "1000", currency: "USD" },
          estimatedYearlyIncome: "INCOME_100K_TO_250K",
          employmentIndustrySector: "INFORMATION",
        },
      },
    },
    status: "active",
    createdBy: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function counterpartyRow(overrides?: Partial<CounterpartyRow>): CounterpartyRow {
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

describe("bvnkCounterpartyRequirements", () => {
  it("does not report ready just because the BVNK customer exists", () => {
    const requirements = bvnkCounterpartyRequirements(counterparty(), {
      direction: "onramp",
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

  it("reports onboarding_not_started when stored KYC is complete but no BVNK customer exists", () => {
    const requirements = bvnkCounterpartyRequirements(counterparty(), {
      direction: "onramp",
      providerData: {},
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "onboarding_not_started",
    });
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

    const payload = buildBvnkIndividualPayload(row, undefined, "USD");

    expect(payload.address).toMatchObject({ countryCode: "US", stateCode: "TX" });
  });
});
