import { describe, expect, it } from "vitest";
import type { CounterpartyProviderAccountRow } from "@/db/repositories";
import { selectLightsparkPayoutAccount } from "./lightspark";

describe("selectLightsparkPayoutAccount", () => {
  it("rejects multiple active accounts when no explicit rail can disambiguate them", () => {
    const accounts = [
      {
        id: "counterparty_provider_account_ach",
        organization_id: "org_test",
        project_id: "prj_test",
        counterparty_id: "cp_test",
        provider: "lightspark",
        provider_customer_reference: "Customer:cus_test",
        external_account_reference: "ExternalAccount:ach",
        fiat_currency: "USD",
        destination_country: "US",
        payment_rail: "ACH",
        provider_status: "ACTIVE",
        status: "active",
        metadata: {},
        created_at: "2026-09-02T00:00:00.000Z",
        updated_at: "2026-09-02T00:00:00.000Z",
      },
      {
        id: "counterparty_provider_account_ach_two",
        organization_id: "org_test",
        project_id: "prj_test",
        counterparty_id: "cp_test",
        provider: "lightspark",
        provider_customer_reference: "Customer:cus_test",
        external_account_reference: "ExternalAccount:ach_two",
        fiat_currency: "USD",
        destination_country: "US",
        payment_rail: "ACH",
        provider_status: "ACTIVE",
        status: "active",
        metadata: {},
        created_at: "2026-09-02T00:00:01.000Z",
        updated_at: "2026-09-02T00:00:01.000Z",
      },
    ] as const satisfies CounterpartyProviderAccountRow[];

    expect(() => selectLightsparkPayoutAccount(accounts, undefined, "USD", "US")).toThrowError(
      "explicit external-account selection is required"
    );
  });

  it("reuses the single active account when no rail was collected", () => {
    const account = {
      id: "counterparty_provider_account_only",
      organization_id: "org_test",
      project_id: "prj_test",
      counterparty_id: "cp_test",
      provider: "lightspark",
      provider_customer_reference: "Customer:cus_test",
      external_account_reference: "ExternalAccount:only",
      fiat_currency: "USD",
      destination_country: "MY",
      payment_rail: "SWIFT",
      provider_status: "ACTIVE",
      status: "active",
      metadata: {},
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    } as const satisfies CounterpartyProviderAccountRow;

    expect(selectLightsparkPayoutAccount([account], undefined, "USD", "MY")).toBe(account);
  });

  it("picks the unique rail match among multiple active accounts", () => {
    const base = {
      organization_id: "org_test",
      project_id: "prj_test",
      counterparty_id: "cp_test",
      provider: "lightspark",
      provider_customer_reference: "Customer:cus_test",
      fiat_currency: "USD",
      destination_country: "US",
      provider_status: "ACTIVE",
      status: "active",
      metadata: {},
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    } as const;
    const ach = {
      ...base,
      id: "counterparty_provider_account_ach",
      external_account_reference: "ExternalAccount:ach",
      payment_rail: "ACH",
    } as const satisfies CounterpartyProviderAccountRow;
    const swift = {
      ...base,
      id: "counterparty_provider_account_swift",
      external_account_reference: "ExternalAccount:swift",
      payment_rail: "SWIFT",
    } as const satisfies CounterpartyProviderAccountRow;

    expect(selectLightsparkPayoutAccount([ach, swift], "SWIFT", "USD", "US")).toBe(swift);
  });
});
