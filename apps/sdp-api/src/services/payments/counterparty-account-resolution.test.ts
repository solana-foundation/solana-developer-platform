import { describe, expect, it } from "vitest";
import type { CounterpartyAccountWithCounterpartyStatusRow } from "@/db/repositories/counterparty-account.repository";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { resolveCounterpartyAccountDestination } from "./counterparty-account-resolution";

const ACTIVE_SOLANA_ACCOUNT: CounterpartyAccountWithCounterpartyStatusRow = {
  id: "counterparty_account_resolution_test",
  organization_id: "org_resolution_test",
  project_id: "prj_resolution_test",
  counterparty_id: "cpty_resolution_test",
  account_kind: "crypto_wallet",
  label: null,
  details: { network: "solana", address: TEST_SOLANA_ADDRESSES.wallet2 },
  provider_account_data: {},
  status: "active",
  created_at: "2026-10-22T00:00:00.000Z",
  updated_at: "2026-10-22T00:00:00.000Z",
  counterparty_status: "active",
};

function resolve(account: CounterpartyAccountWithCounterpartyStatusRow) {
  return () => resolveCounterpartyAccountDestination({ account, field: "counterpartyAccountId" });
}

describe("resolveCounterpartyAccountDestination", () => {
  it("returns the address of an active Solana wallet account of an active counterparty", () => {
    expect(resolve(ACTIVE_SOLANA_ACCOUNT)()).toBe(TEST_SOLANA_ADDRESSES.wallet2);
  });

  it("refuses an archived account as not found", () => {
    expect(resolve({ ...ACTIVE_SOLANA_ACCOUNT, status: "archived" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 })
    );
  });

  it("refuses an active account of an archived counterparty as not found", () => {
    expect(resolve({ ...ACTIVE_SOLANA_ACCOUNT, counterparty_status: "archived" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 })
    );
  });

  it("refuses a wallet account on another network as a bad request", () => {
    const ethereumAccount = {
      ...ACTIVE_SOLANA_ACCOUNT,
      details: { network: "ethereum", address: "0x0000000000000000000000000000000000000001" },
    };
    expect(resolve(ethereumAccount)).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "counterpartyAccountId must be a Solana wallet account",
      })
    );
  });
});
