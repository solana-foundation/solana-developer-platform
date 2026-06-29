import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { buildBvnkOnrampPaymentRuleKey } from "@/lib/ramps/providers/bvnk";
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
    identity: {},
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
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      destinationWalletAddress: "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi",
    };

    const first = await bvnkOnrampQuote(fakeContext(), input);
    const second = await bvnkOnrampQuote(fakeContext(), input);

    expect(first.id).not.toBe(ruleId);
    expect(second.id).not.toBe(ruleId);
    expect(second.id).not.toBe(first.id);
    expect(first.id.startsWith("bvnk_onramp_")).toBe(true);

    const instruction = first.paymentInstructions.find((item) => item.kind === "fiat_funding");
    expect(instruction?.ruleId).toBe(ruleId);
    expect(instruction?.fundingWalletId).toBe("wallet_bvnk_123");
  });
});
