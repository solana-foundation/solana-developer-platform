import { SdpPaymentsError } from "@sdp/payments";
import {
  buildMuralPhysicalAddress,
  muralCounterpartyRequirements,
  muralOnboardingRequirements,
} from "@sdp/payments/ramps/providers/mural/counterparty";
import type { MuralOrganizationResolution } from "@sdp/payments/ramps/providers/mural/provider-data";
import type { Counterparty, CounterpartyProviderData } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { describe, expect, it } from "vitest";

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

const USD: RampFiatCurrency = "USD";
const COLLECTED_ADDRESS = {
  "address.line1": "1 Market St",
  "address.city": "San Francisco",
  "address.postalCode": "94105",
  "address.subdivisionCode": "CA",
} as const;

describe("muralCounterpartyRequirements", () => {
  it("collects a physical address before starting onboarding", () => {
    const requirements = muralCounterpartyRequirements(counterparty(), {
      direction: "onramp",
      country: "US",
      providerData: {},
    });
    expect(requirements).toMatchObject({
      provider: "mural",
      direction: "onramp",
      status: "collect",
    });
    if (requirements.status !== "collect") throw new Error("Expected collect requirements");
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "address.line1",
      "address.line2",
      "address.city",
      "address.postalCode",
      "address.subdivisionCode",
    ]);
  });

  it("is ready for onramp once the org is approved", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "onramp",
        country: "US",
        providerData: providerData({ id: "org_1", tosStatus: "ACCEPTED", kycStatus: "approved" }),
      }).status
    ).toBe("ready");
  });

  it("requires fiatCurrency for offramp", () => {
    expect(() =>
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        country: "US",
        providerData: {},
      })
    ).toThrow(SdpPaymentsError);
  });

  it("is unsupported for an unsupported off-ramp currency", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        country: "US",
        providerData: {},
        fiatCurrency: "EUR" as RampFiatCurrency,
      }).status
    ).toBe("unsupported");
  });

  it("starts onboarding when no organization exists", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        country: "US",
        providerData: {},
        fiatCurrency: USD,
        collectedData: COLLECTED_ADDRESS,
      })
    ).toEqual({ provider: "mural", direction: "offramp", status: "onboarding_not_started" });
  });

  it("surfaces the KYC link once an org is provisioned and TOS accepted", () => {
    expect(
      muralCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        country: "US",
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

describe("buildMuralPhysicalAddress", () => {
  it("builds a physical address from transient values and request country", () => {
    expect(buildMuralPhysicalAddress("US", COLLECTED_ADDRESS)).toEqual({
      address1: "1 Market St",
      city: "San Francisco",
      zip: "94105",
      state: "CA",
      country: "US",
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
