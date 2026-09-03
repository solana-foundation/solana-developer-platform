import { SdpPaymentsError } from "@sdp/payments";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  lightsparkCounterpartyRequirements,
} from "@sdp/payments/ramps/providers/lightspark/counterparty";
import { isLightsparkPurposeOfPayment } from "@sdp/payments/ramps/providers/lightspark/provider-data";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";

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

function counterpartyRow(overrides?: Partial<CounterpartyRow>): CounterpartyRow {
  return {
    id: "cp_123",
    organization_id: "org_123",
    project_id: "proj_123",
    external_id: null,
    entity_type: "individual",
    display_name: "Ada Lovelace",
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function businessCounterparty(): Counterparty {
  return {
    ...counterparty(),
    entityType: "business",
    displayName: "Acme Corp",
  };
}

describe("lightsparkCounterpartyRequirements", () => {
  it("collects individual PII when the counterparty has no provider customer", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "onramp",
      providerData: {},
    });

    if (requirements.status !== "collect_counterparty") {
      throw new Error("Expected collect_counterparty requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "customer.fullName",
      "customer.birthDate",
      "customer.nationality",
      "customer.region",
      "customer.email",
      "customer.address",
      "purposeOfPayment",
    ]);
    const addressField = requirements.fields.find((field) => field.kind === "address");
    if (addressField === undefined) {
      throw new Error("Expected an address field");
    }
    expect(addressField.fields.map((field) => field.key)).toEqual([
      "customer.address.line1",
      "customer.address.city",
      "customer.address.subdivisionCode",
      "customer.address.postalCode",
      "customer.address.countryCode",
    ]);
  });

  it("collects individual PII for offramp too when no provider customer exists", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "USD",
    });

    expect(requirements.status).toBe("collect_counterparty");
  });

  it("returns ready for onramp once the provider customer is linked", () => {
    expect(
      lightsparkCounterpartyRequirements(counterparty(), {
        direction: "onramp",
        providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
        providerCustomerReference: "Customer:cus_123",
      })
    ).toEqual({ provider: "lightspark", direction: "onramp", status: "ready" });
  });

  it("collects only the purpose-of-payment for linked customers missing it", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "onramp",
      providerData: {},
      providerCustomerReference: "Customer:cus_123",
    });

    if (requirements.status !== "collect_counterparty") {
      throw new Error("Expected collect_counterparty requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual(["purposeOfPayment"]);
    const purposeField = requirements.fields[0];
    if (purposeField?.kind !== "select") {
      throw new Error("Expected purposeOfPayment select field");
    }
    expect(purposeField.options.map((option) => option.value)).toContain("GOODS_OR_SERVICES");
  });

  it("rejects prototype property names as purpose-of-payment codes", () => {
    expect(isLightsparkPurposeOfPayment("GOODS_OR_SERVICES")).toBe(true);
    expect(isLightsparkPurposeOfPayment("toString")).toBe(false);
    expect(isLightsparkPurposeOfPayment("constructor")).toBe(false);
  });

  it("requires fiatCurrency for offramp", () => {
    expect(() =>
      lightsparkCounterpartyRequirements(counterparty(), {
        direction: "offramp",
        providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
        providerCustomerReference: "Customer:cus_123",
      })
    ).toThrowError(SdpPaymentsError);
  });

  it("builds the USD destination-first payout tree", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements.status).toBe("collect_account");
    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.payout.countryRails.US).toEqual([
      { value: "ACH", label: "ACH" },
      { value: "FEDNOW", label: "FedNow" },
      { value: "RTP", label: "RTP" },
      { value: "WIRE", label: "Wire" },
      { value: "SWIFT", label: "SWIFT" },
    ]);
    expect(requirements.payout.railFields.ACH).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "bankAccount.routingNumber", required: true }),
      ])
    );
  });

  it("offers SWIFT alongside the local rails for every currency", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "GBP",
      cryptoRail: "usdc.solana",
      providerCustomerReference: "Customer:cus_123",
    });

    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.payout.countryRails.GB).toEqual([
      { value: "FASTER_PAYMENTS", label: "Faster Payments" },
      { value: "SWIFT", label: "SWIFT" },
    ]);
  });

  it("reports existing payout accounts in the payout tree", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {
        lightspark: {
          purposeOfPayment: "GOODS_OR_SERVICES",
        },
      },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      payoutAccounts: [
        {
          id: "account_us",
          destinationCountry: "US",
          paymentRail: null,
          status: "ACTIVE",
        },
      ],
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements.status).toBe("collect_account");
    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.payout.accounts).toEqual([
      {
        id: "account_us",
        destinationCountry: "US",
        paymentRail: null,
        status: "ACTIVE",
      },
    ]);
  });

  it("returns unsupported for currencies without a Grid payout account type", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "TRY",
      cryptoRail: "usdc.solana",
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements.status).toBe("unsupported");
  });

  it("collects businessInfo fields for a business without a provider customer", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "onramp",
      providerData: {},
    });

    if (requirements.status !== "collect_counterparty") {
      throw new Error("Expected collect_counterparty requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "businessLegalName",
      "businessTaxId",
      "businessIncorporatedOn",
      "purposeOfPayment",
    ]);
  });

  it("returns ready for a business on-ramp once the provider customer is linked", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "onramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements).toEqual({ provider: "lightspark", direction: "onramp", status: "ready" });
  });

  it("builds the payout tree for a business counterparty", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      providerCustomerReference: "Customer:cus_123",
    });

    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.payout.railFields).toHaveProperty("ACH");
  });
});

describe("buildLightsparkBusinessInfo", () => {
  it("maps collected fields into the Grid businessInfo payload", () => {
    expect(
      buildLightsparkBusinessInfo({
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "2018-03-14",
        purposeOfPayment: "GOODS_OR_SERVICES",
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
        purposeOfPayment: "GOODS_OR_SERVICES",
      })
    ).toThrowError(SdpPaymentsError);
  });
});

describe("buildLightsparkAccountInfo", () => {
  it("builds USD accountInfo with the selected rail and beneficiary", () => {
    const accountInfo = buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "USD", {
      destinationCountry: "US",
      paymentRails: "ACH",
      "bankAccount.routingNumber": "021000021",
      "bankAccount.accountNumber": "12345678901",
    });

    expect(accountInfo).toEqual({
      accountType: "USD_ACCOUNT",
      paymentRails: ["ACH"],
      routingNumber: "021000021",
      accountNumber: "12345678901",
      beneficiary: {
        beneficiaryType: "INDIVIDUAL",
        fullName: "Ada Lovelace",
      },
    });
  });

  it("builds XOF mobile money accountInfo with the region select", () => {
    const accountInfo = buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "XOF", {
      destinationCountry: "SN",
      paymentRails: "MOBILE_MONEY",
      "bankAccount.phoneNumber": "+221770000000",
      "bankAccount.provider": "Orange Money",
      "bankAccount.region": "SN",
    });

    expect(accountInfo).toEqual({
      accountType: "XOF_ACCOUNT",
      paymentRails: ["MOBILE_MONEY"],
      phoneNumber: "+221770000000",
      provider: "Orange Money",
      region: "SN",
      beneficiary: {
        beneficiaryType: "INDIVIDUAL",
        fullName: "Ada Lovelace",
      },
    });
  });

  it("uses a business legal name for business counterparties", () => {
    const individualRow = counterpartyRow();
    const businessRow: CounterpartyRow = {
      ...individualRow,
      entity_type: "business",
      display_name: "Acme Corp",
    };
    const accountInfo = buildLightsparkAccountInfo(businessRow, "usdc.solana", "GBP", {
      destinationCountry: "GB",
      paymentRails: "FASTER_PAYMENTS",
      "bankAccount.sortCode": "123456",
      "bankAccount.accountNumber": "12345678",
    });

    expect(accountInfo.beneficiary).toEqual({
      beneficiaryType: "BUSINESS",
      legalName: "Acme Corp",
    });
  });

  it("throws when collectedData is missing", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "USD", undefined)
    ).toThrowError(SdpPaymentsError);
  });

  it("throws when collected fields fail validation", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "USD", {
        destinationCountry: "US",
        paymentRails: "ACH",
        "bankAccount.routingNumber": "not-a-routing-number",
        "bankAccount.accountNumber": "12345678901",
      })
    ).toThrowError(SdpPaymentsError);
  });

  it("rejects a country with no resolved payout rails", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "USD", {
        destinationCountry: "ZZ",
        paymentRails: "ACH",
        "bankAccount.routingNumber": "021000021",
        "bankAccount.accountNumber": "12345678901",
      })
    ).toThrowError(SdpPaymentsError);
  });

  it("rejects a rail that is not available for the destination", () => {
    expect(() =>
      buildLightsparkAccountInfo(counterpartyRow(), "usdc.solana", "USD", {
        destinationCountry: "US",
        paymentRails: "SEPA",
        "bankAccount.routingNumber": "021000021",
        "bankAccount.accountNumber": "12345678901",
      })
    ).toThrowError(SdpPaymentsError);
  });
});
