import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { bvnkCounterpartyRequirements } from "./bvnk";

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
