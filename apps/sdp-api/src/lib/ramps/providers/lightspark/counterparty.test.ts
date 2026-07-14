import { SdpPaymentsError } from "@sdp/payments";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  lightsparkCounterpartyRequirements,
  lightsparkPayoutCollectedData,
} from "./counterparty";

type IndividualCounterparty = Extract<Counterparty, { entityType: "individual" }>;
type BusinessCounterparty = Extract<Counterparty, { entityType: "business" }>;
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
      address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
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
    identity: {
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1990-01-15",
      phone: "+14155551234",
      address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
    },
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function businessCounterparty(): BusinessCounterparty {
  const base = counterparty();
  return {
    ...base,
    entityType: "business",
    displayName: "Acme Corp",
    identity: { address: base.identity.address },
  };
}

describe("lightsparkCounterpartyRequirements", () => {
  it("returns ready for onramp", () => {
    expect(
      lightsparkCounterpartyRequirements(counterparty(), {
        direction: "onramp",
        providerData: {},
      })
    ).toEqual({ provider: "lightspark", direction: "onramp", status: "ready" });
  });

  it("requires fiatCurrency for offramp", () => {
    expect(() =>
      lightsparkCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        providerData: {},
      })
    ).toThrowError(SdpPaymentsError);
  });

  it("collects USD payout bank fields including the rail select", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "USD",
    });

    expect(requirements.status).toBe("collect");
    if (requirements.status !== "collect") {
      throw new Error("Expected collect requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "paymentRails",
      "routingNumber",
      "accountNumber",
    ]);
    const railField = requirements.fields[0];
    if (railField?.kind !== "select") {
      throw new Error("Expected paymentRails select field");
    }
    expect(railField.options.map((option) => option.value)).toEqual([
      "ACH",
      "WIRE",
      "RTP",
      "FEDNOW",
    ]);
  });

  it("omits the rail select for single-rail currencies", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "GBP",
    });

    if (requirements.status !== "collect") {
      throw new Error("Expected collect requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual(["sortCode", "accountNumber"]);
  });

  it("returns ready once a payout account is stored for the currency", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {
        lightspark: {
          customerId: "Customer:cus_123",
          payoutAccounts: {
            "USD:ab12cd34ef56ab12": {
              accountId: "ExternalAccount:acc_payout_123",
              status: "ACTIVE",
              createdAt: "2026-06-11T00:00:00.000Z",
            },
          },
        },
      },
      fiatCurrency: "USD",
    });

    expect(requirements).toEqual({ provider: "lightspark", direction: "offramp", status: "ready" });
  });

  it("returns unsupported for currencies without a Grid payout account type", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "TRY",
    });

    expect(requirements.status).toBe("unsupported");
  });

  it("returns unsupported for business on-ramp", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "onramp",
      providerData: {},
    });

    expect(requirements.status).toBe("unsupported");
  });

  it("collects businessInfo fields before the payout fields for a business without a Grid customer", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "USD",
    });

    if (requirements.status !== "collect") {
      throw new Error("Expected collect requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "businessLegalName",
      "businessTaxId",
      "businessIncorporatedOn",
      "paymentRails",
      "routingNumber",
      "accountNumber",
    ]);
  });

  it("collects only payout fields once the business has a Grid customer", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "offramp",
      providerData: { lightspark: { customerId: "Customer:cus_123" } },
      fiatCurrency: "USD",
    });

    if (requirements.status !== "collect") {
      throw new Error("Expected collect requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "paymentRails",
      "routingNumber",
      "accountNumber",
    ]);
  });
});

describe("buildLightsparkBusinessInfo", () => {
  it("maps collected fields into the Grid businessInfo payload", () => {
    expect(
      buildLightsparkBusinessInfo({
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "2018-03-14",
      })
    ).toEqual({
      legalName: "Acme Corporation, Inc.",
      taxId: "47-1234567",
      incorporatedOn: "2018-03-14",
    });
  });

  it("throws when collectedData is missing", () => {
    expect(() => buildLightsparkBusinessInfo(undefined)).toThrowError(SdpPaymentsError);
  });

  it("throws when the incorporation date is not an ISO date", () => {
    expect(() =>
      buildLightsparkBusinessInfo({
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "March 14, 2018",
      })
    ).toThrowError(SdpPaymentsError);
  });
});

describe("lightsparkPayoutCollectedData", () => {
  it("drops business onboarding fields from the payout subset", () => {
    expect(
      lightsparkPayoutCollectedData("USD", {
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "2018-03-14",
        paymentRails: "ACH",
        routingNumber: "021000021",
        accountNumber: "12345678901",
      })
    ).toEqual({
      paymentRails: "ACH",
      routingNumber: "021000021",
      accountNumber: "12345678901",
    });
  });

  it("returns undefined when no payout fields were collected", () => {
    expect(
      lightsparkPayoutCollectedData("USD", {
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "2018-03-14",
      })
    ).toBeUndefined();
  });
});

describe("buildLightsparkAccountInfo", () => {
  it("builds USD accountInfo with the selected rail and beneficiary", () => {
    const accountInfo = buildLightsparkAccountInfo(
      counterpartyRow({
        identity: {
          firstName: "Ada",
          lastName: "Lovelace",
          dateOfBirth: "1990-01-15",
          phone: "+14155551234",
          address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
        },
      }),
      "USD",
      {
        paymentRails: "ACH",
        routingNumber: "021000021",
        accountNumber: "12345678901",
      }
    );

    expect(accountInfo).toEqual({
      accountType: "USD_ACCOUNT",
      paymentRails: ["ACH"],
      routingNumber: "021000021",
      accountNumber: "12345678901",
      beneficiary: {
        beneficiaryType: "INDIVIDUAL",
        fullName: "Ada Lovelace",
        birthDate: "1990-01-15",
      },
    });
  });

  it("hardcodes the rail and wraps countries for XOF mobile money", () => {
    const accountInfo = buildLightsparkAccountInfo(counterpartyRow(), "XOF", {
      phoneNumber: "+221770000000",
      provider: "Orange Money",
      countries: "SN",
    });

    expect(accountInfo).toEqual({
      accountType: "XOF_ACCOUNT",
      paymentRails: ["MOBILE_MONEY"],
      phoneNumber: "+221770000000",
      provider: "Orange Money",
      countries: ["SN"],
      beneficiary: {
        beneficiaryType: "INDIVIDUAL",
        fullName: "Ada Lovelace",
        birthDate: "1990-01-15",
      },
    });
  });

  it("uses a business legal name for business counterparties", () => {
    const individualRow = counterpartyRow();
    const businessRow: CounterpartyRow = {
      ...individualRow,
      entity_type: "business",
      display_name: "Acme Corp",
      identity: { address: individualRow.identity.address },
    };
    const accountInfo = buildLightsparkAccountInfo(businessRow, "GBP", {
      sortCode: "12-34-56",
      accountNumber: "12345678",
    });

    expect(accountInfo.beneficiary).toEqual({
      beneficiaryType: "BUSINESS",
      legalName: "Acme Corp",
    });
  });

  it("throws when collectedData is missing", () => {
    expect(() => buildLightsparkAccountInfo(counterpartyRow(), "USD", undefined)).toThrowError(
      SdpPaymentsError
    );
  });

  it("throws when collected fields fail validation", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "USD", {
        paymentRails: "ACH",
        routingNumber: "not-a-routing-number",
        accountNumber: "12345678901",
      })
    ).toThrowError(SdpPaymentsError);
  });
});
