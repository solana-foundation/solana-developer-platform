import { SdpPaymentsError } from "@sdp/payments";
import {
  buildLightsparkAccountInfo,
  buildLightsparkBusinessInfo,
  lightsparkCounterpartyRequirements,
  lightsparkPayoutCollectedData,
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
      "purposeOfPayment",
      "customer.address",
    ]);
    const addressField = requirements.fields.at(-1);
    if (addressField?.kind !== "address") {
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

  it("collects USD payout bank fields including the rail select", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements.status).toBe("collect_account");
    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "paymentRails",
      "accountNumber",
      "bankAccountType",
      "bankName",
      "fiToFiInformation",
      "intermediaryBankName",
      "intermediaryRoutingNumber",
      "routingNumber",
      "country",
      "iban",
      "swiftCode",
    ]);
    const railField = requirements.fields[0];
    if (railField?.kind !== "select") {
      throw new Error("Expected paymentRails select field");
    }
    expect(railField.options.map((option) => option.value)).toEqual([
      "ACH",
      "FEDNOW",
      "RTP",
      "WIRE",
      "SWIFT",
    ]);
  });

  it("offers SWIFT alongside the local rails for every currency", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "GBP",
      providerCustomerReference: "Customer:cus_123",
    });

    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "paymentRails",
      "accountNumber",
      "sortCode",
      "bankName",
      "country",
      "iban",
      "swiftCode",
    ]);
    const railField = requirements.fields[0];
    if (railField?.kind !== "select") {
      throw new Error("Expected paymentRails select field");
    }
    expect(railField.options.map((option) => option.value)).toEqual(["FASTER_PAYMENTS", "SWIFT"]);
  });

  it("returns ready once a payout account is stored for the currency", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: {
        lightspark: {
          customerId: "Customer:cus_123",
          purposeOfPayment: "GOODS_OR_SERVICES",
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
      providerCustomerReference: "Customer:cus_123",
    });

    expect(requirements).toEqual({ provider: "lightspark", direction: "offramp", status: "ready" });
  });

  it("returns unsupported for currencies without a Grid payout account type", () => {
    const requirements = lightsparkCounterpartyRequirements(counterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "TRY",
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

  it("collects only payout fields once the business has a provider customer", () => {
    const requirements = lightsparkCounterpartyRequirements(businessCounterparty(), {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      providerCustomerReference: "Customer:cus_123",
    });

    if (requirements.status !== "collect_account") {
      throw new Error("Expected collect_account requirements");
    }
    expect(requirements.fields.map((field) => field.key)).toEqual([
      "paymentRails",
      "accountNumber",
      "bankAccountType",
      "bankName",
      "fiToFiInformation",
      "intermediaryBankName",
      "intermediaryRoutingNumber",
      "routingNumber",
      "country",
      "iban",
      "swiftCode",
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

describe("lightsparkPayoutCollectedData", () => {
  it("drops business onboarding fields from the payout subset", () => {
    expect(
      lightsparkPayoutCollectedData("USD", {
        businessLegalName: "Acme Corporation, Inc.",
        businessTaxId: "47-1234567",
        businessIncorporatedOn: "2018-03-14",
        purposeOfPayment: "GOODS_OR_SERVICES",
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
    const accountInfo = buildLightsparkAccountInfo(counterpartyRow(), "USD", {
      paymentRails: "ACH",
      routingNumber: "021000021",
      accountNumber: "12345678901",
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
    const accountInfo = buildLightsparkAccountInfo(counterpartyRow(), "XOF", {
      paymentRails: "MOBILE_MONEY",
      phoneNumber: "+221770000000",
      provider: "Orange Money",
      region: "SN",
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
    const accountInfo = buildLightsparkAccountInfo(businessRow, "GBP", {
      paymentRails: "FASTER_PAYMENTS",
      sortCode: "123456",
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
