import { SdpPaymentsError } from "@sdp/payments";
import type { Counterparty, CounterpartyProviderData } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { describe, expect, it } from "vitest";
import { muralCounterpartyRequirements, muralOnboardingRequirements } from "./counterparty";
import type { MuralOrganizationResolution } from "./provider-data";

type IndividualCounterparty = Extract<Counterparty, { entityType: "individual" }>;

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
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

function providerData(organization: MuralOrganizationResolution): CounterpartyProviderData {
  return { mural: { organization } };
}

const USD = "USD" as RampFiatCurrency;

describe("muralCounterpartyRequirements", () => {
  it("starts onboarding for onramp without a fiat currency gate", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), { direction: "onramp", providerData: {} })
    ).toEqual({ provider: "mural", direction: "onramp", status: "onboarding_not_started" });
  });

  it("is ready for onramp once the org is approved", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "onramp",
        providerData: providerData({ id: "org_1", tosStatus: "ACCEPTED", kycStatus: "approved" }),
      }).status
    ).toBe("ready");
  });

  it("requires fiatCurrency for offramp", () => {
    expect(() =>
      muralCounterpartyRequirements(counterparty(), { direction: "offramp", providerData: {} })
    ).toThrow(SdpPaymentsError);
  });

  it("is unsupported for an unsupported off-ramp currency", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        providerData: {},
        fiatCurrency: "EUR" as RampFiatCurrency,
      }).status
    ).toBe("unsupported");
  });

  it("starts onboarding when no organization exists", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        providerData: {},
        fiatCurrency: USD,
      })
    ).toEqual({ provider: "mural", direction: "offramp", status: "onboarding_not_started" });
  });

  it("surfaces the KYC link once an org is provisioned and TOS accepted", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        providerData: providerData({
          id: "org_1",
          tosStatus: "ACCEPTED",
          kycStatus: "inactive",
          kycLink: "https://kyc.example/abc",
        }),
        fiatCurrency: USD,
      })
    ).toEqual({
      provider: "mural",
      direction: "offramp",
      status: "customer_verification_required",
      verificationUrl: "https://kyc.example/abc",
    });
  });
});

describe("muralOnboardingRequirements", () => {
  it("returns onboarding_not_started without an org id", () => {
    expect(muralOnboardingRequirements({}, "offramp").status).toBe("onboarding_not_started");
  });

  it("requires terms of service when TOS is not accepted", () => {
    expect(
      muralOnboardingRequirements(
        { id: "org_1", tosStatus: "NOT_ACCEPTED", kycStatus: "inactive", tosLink: "https://tos" },
        "offramp"
      )
    ).toEqual({
      provider: "mural",
      direction: "offramp",
      status: "terms_of_service_required",
      termsOfServiceUrl: "https://tos",
    });
  });

  it("reports verifying while KYC is pending", () => {
    expect(
      muralOnboardingRequirements(
        { id: "org_1", tosStatus: "ACCEPTED", kycStatus: "pending" },
        "offramp"
      ).status
    ).toBe("customer_verifying");
  });

  it("is ready when KYC is approved", () => {
    expect(
      muralOnboardingRequirements(
        { id: "org_1", tosStatus: "ACCEPTED", kycStatus: "approved" },
        "offramp"
      )
    ).toEqual({ provider: "mural", direction: "offramp", status: "ready" });
  });

  it.each(["errored", "rejected"] as const)("fails verification when KYC is %s", (kycStatus) => {
    expect(
      muralOnboardingRequirements({ id: "org_1", tosStatus: "ACCEPTED", kycStatus }, "offramp")
        .status
    ).toBe("customer_verification_failed");
  });

  it("reports verifying once TOS is accepted but the KYC link has not landed yet", () => {
    expect(
      muralOnboardingRequirements(
        { id: "org_1", tosStatus: "ACCEPTED", kycStatus: "inactive" },
        "offramp"
      ).status
    ).toBe("customer_verifying");
  });

  it("reports verifying when no link has been minted for the pure read path", () => {
    expect(
      muralOnboardingRequirements(
        { id: "org_1", tosStatus: "NOT_ACCEPTED", kycStatus: "inactive" },
        "offramp"
      ).status
    ).toBe("customer_verifying");
  });
});
