import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import {
  type BvnkOnrampRequestSpec,
  buildBvnkOnrampPaymentRuleKey,
} from "@/lib/ramps/providers/bvnk/provider-data";
import type { AppContext } from "../../context";
import { bvnkOnrampQuote } from "./bvnk";

function fakeContext(): AppContext {
  return {
    get: (key: string) => (key === "apiKey" ? { environment: "sandbox" } : undefined),
  } as unknown as AppContext;
}

function counterpartyWithBvnkRule(ruleId: string): CounterpartyRow {
  const destinationWalletAddress = "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi";
  const paymentRuleKey = buildBvnkOnrampPaymentRuleKey(
    "USD",
    "USDC",
    "SOLANA",
    destinationWalletAddress
  );

  return {
    id: "counterparty_123e4567-e89b-12d3-a456-426614174000",
    organization_id: "org_test",
    project_id: "prj_test",
    external_id: null,
    entity_type: "individual",
    display_name: "BVNK Test Counterparty",
    email: "bvnk@example.com",
    identity: {
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1990-01-15",
      phone: "+14155551234",
      address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
    },
    provider_data: {
      bvnk: {
        customer: { customerReference: "cust_bvnk_123", status: "VERIFIED" },
        wallets: {
          [paymentRuleKey]: {
            walletId: "wallet_bvnk_123",
            walletStatus: "ACTIVE",
            ruleId,
            ruleStatus: "ACTIVE",
            bankAccount: { accountNumber: "000123456789", bankName: "BVNK Bank" },
          },
        },
      },
    },
    status: "active",
    created_by: null,
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  };
}

describe("bvnkOnrampQuote", () => {
  it("uses a per-transaction quote id while keeping the BVNK payment rule id in instructions", async () => {
    const ruleId = "rule_bvnk_quote_123";
    const counterparty = counterpartyWithBvnkRule(ruleId);
    const input = {
      counterparty,
      paymentRule: {
        currency: "USDC",
        network: "SOLANA",
        fiatCurrency: "USD",
        destinationWalletAddress: "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi",
      } satisfies BvnkOnrampRequestSpec,
    };

    const first = await bvnkOnrampQuote(fakeContext(), input);
    const second = await bvnkOnrampQuote(fakeContext(), input);

    expect(first.quote.id).not.toBe(ruleId);
    expect(second.quote.id).not.toBe(ruleId);
    expect(second.quote.id).not.toBe(first.quote.id);
    expect(first.quote.id.startsWith("bvnk_onramp_")).toBe(true);

    const instruction = first.quote.paymentInstructions.find(
      (item) => item.kind === "fiat_funding"
    );
    expect(instruction?.ruleId).toBe(ruleId);
    expect(instruction?.fundingWalletId).toBe("wallet_bvnk_123");
    expect(first.transferProviderData).toEqual({
      bvnk: { ruleId, ruleStatus: "ACTIVE", fundingWalletId: "wallet_bvnk_123" },
    });
  });
});
