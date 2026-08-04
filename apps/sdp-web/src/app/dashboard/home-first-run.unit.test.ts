import type { CustodyWalletTokenBalance } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { resolveHomeHeroState } from "./home-first-run";

function balance(overrides: Partial<CustodyWalletTokenBalance>): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-usdc",
    amount: "1000000",
    uiAmount: "1",
    decimals: 6,
    ...overrides,
  };
}

describe("resolveHomeHeroState", () => {
  it("treats an organization with no wallets as first run", () => {
    expect(resolveHomeHeroState({ walletCount: 0, balances: [], totalBalance: null })).toEqual({
      kind: "first_run",
    });
  });

  it("treats a freshly onboarded organization as provisioned-but-empty", () => {
    // Onboarding provisions a wallet before it completes, so walletCount is 1 with
    // nothing in it. The old `wallets.length === 0` gate called this populated and
    // rendered $0.00 as the first thing a new organization ever saw.
    expect(resolveHomeHeroState({ walletCount: 1, balances: [], totalBalance: null })).toEqual({
      kind: "provisioned_empty",
    });
  });

  it("ignores spent token accounts that still report a zero amount", () => {
    const result = resolveHomeHeroState({
      walletCount: 1,
      balances: [balance({ uiAmount: "0" })],
      totalBalance: null,
    });

    expect(result).toEqual({ kind: "provisioned_empty" });
  });

  it("marks holdings with no price feed as populated without priced value", () => {
    // An organization holding only its own issued tokens. Real holdings, no USD
    // total, so a currency figure would be a false zero rather than a balance.
    const result = resolveHomeHeroState({
      walletCount: 1,
      balances: [balance({ mint: "atd", token: "ATD", uiAmount: "25000" })],
      totalBalance: null,
    });

    expect(result).toEqual({ kind: "populated", hasPricedValue: false });
  });

  it("marks priced holdings as populated with priced value", () => {
    const result = resolveHomeHeroState({
      walletCount: 2,
      balances: [balance({ usdValue: 149.11 })],
      totalBalance: 149.11,
    });

    expect(result).toEqual({ kind: "populated", hasPricedValue: true });
  });

  it("keeps a genuine zero total as priced rather than unpriced", () => {
    // Distinct from the unpriced case: the feed answered, and it said zero.
    const result = resolveHomeHeroState({
      walletCount: 1,
      balances: [balance({ usdValue: 0 })],
      totalBalance: 0,
    });

    expect(result).toEqual({ kind: "populated", hasPricedValue: true });
  });
});
