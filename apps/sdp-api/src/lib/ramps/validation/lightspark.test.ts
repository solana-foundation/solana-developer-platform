import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError } from "@/lib/errors";
import { buildLightsparkAccountInfo, lightsparkCounterpartyRequirements } from "./lightspark";

function counterparty(overrides?: Partial<Counterparty>): Counterparty {
  return {
    id: "cp_123",
    organizationId: "org_123",
    projectId: "proj_123",
    externalId: null,
    entityType: "individual",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    identity: {},
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
    identity: {},
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
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
    ).toThrowError(AppError);
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
});

describe("buildLightsparkAccountInfo", () => {
  it("builds USD accountInfo with the selected rail and beneficiary", () => {
    const accountInfo = buildLightsparkAccountInfo(
      counterpartyRow({ identity: { dateOfBirth: "1990-01-15" } }),
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
      beneficiary: { beneficiaryType: "INDIVIDUAL", fullName: "Ada Lovelace" },
    });
  });

  it("uses a business legal name for business counterparties", () => {
    const accountInfo = buildLightsparkAccountInfo(
      counterpartyRow({ entity_type: "business", display_name: "Acme Corp" }),
      "GBP",
      { sortCode: "12-34-56", accountNumber: "12345678" }
    );

    expect(accountInfo.beneficiary).toEqual({
      beneficiaryType: "BUSINESS",
      legalName: "Acme Corp",
    });
  });

  it("throws when collectedData is missing", () => {
    expect(() => buildLightsparkAccountInfo(counterpartyRow(), "USD", undefined)).toThrowError(
      AppError
    );
  });

  it("throws when collected fields fail validation", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "USD", {
        paymentRails: "ACH",
        routingNumber: "not-a-routing-number",
        accountNumber: "12345678901",
      })
    ).toThrowError(AppError);
  });
});
