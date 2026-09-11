// @vitest-environment jsdom

import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ownParty, testLeg, testTrade } from "./dvp/dvp.fixtures";
import {
  marketsSandboxStorageKey,
  parseMarketsSandboxState,
  useMarketsSandbox,
} from "./markets-sandbox-store";

const DEPOSIT = {
  strategyId: "kamino-usdc",
  provider: "kamino",
  providerReference: "mainnet-vault",
  strategyName: "Mainnet USDC Vault",
  assetSymbol: "USDC",
  assetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payWith: "USDT" as const,
  amount: "250.25",
};

describe("useMarketsSandbox", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("self-funds every demo asset without calling an external service", () => {
    const { result } = renderHook(() => useMarketsSandbox("project-one"));

    act(() => result.current.fund());

    expect(result.current.state.balances).toEqual({
      SOL: "1000",
      USDC: "100000",
      USDG: "100000",
      USDT: "100000",
      PYUSD: "100000",
    });
    expect(result.current.state.activity).toHaveLength(5);
  });

  it("deposits and withdraws stablecoins at an exact one-to-one rate", () => {
    const { result } = renderHook(() => useMarketsSandbox("project-two"));

    act(() => result.current.fund());
    act(() => result.current.deposit(DEPOSIT));

    expect(result.current.state.balances.USDT).toBe("99749.75");
    expect(result.current.state.positions[0]).toMatchObject({
      strategyId: "kamino-usdc",
      amount: "250.25",
      shares: "250.25",
    });
    expect(result.current.state.activity[0]).toMatchObject({
      kind: "deposit",
      amount: "250.25",
      swappedFrom: "USDT",
      swappedTo: "USDC",
    });

    const positionId = result.current.state.positions[0]?.id;
    expect(positionId).toBeTruthy();
    act(() => result.current.withdraw(positionId ?? "", "50.25", "PYUSD"));

    expect(result.current.state.positions[0]?.amount).toBe("200");
    expect(result.current.state.balances.PYUSD).toBe("100050.25");
    expect(result.current.state.activity[0]).toMatchObject({
      kind: "withdrawal",
      amount: "50.25",
      swappedFrom: "USDC",
      swappedTo: "PYUSD",
    });
  });

  it("keeps each project's sandbox ledger isolated", () => {
    const first = renderHook(() => useMarketsSandbox("project-a"));
    const second = renderHook(() => useMarketsSandbox("project-b"));

    act(() => first.result.current.fund());

    expect(first.result.current.state.balances.SOL).toBe("1000");
    expect(second.result.current.state.balances.SOL).toBe("0");
    expect(marketsSandboxStorageKey("project-a")).not.toBe(marketsSandboxStorageKey("project-b"));
  });

  it("runs the DVP funding and settlement lifecycle against the local ledger", () => {
    const { result } = renderHook(() => useMarketsSandbox("dvp-project"));
    const usdc = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
    const usdt = WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address;
    const trade = testTrade({
      legs: {
        a: testLeg({
          party: ownParty(),
          mint: usdc,
          symbol: "USDC",
          amount: "50000000",
        }),
        b: testLeg({ mint: usdt, symbol: "USDT", amount: "50000000" }),
      },
    });

    act(() => result.current.fund());
    act(() => result.current.saveDvpTrade(trade));
    act(() => result.current.actOnDvpTrade(trade.id, "fund", "a"));

    expect(result.current.state.balances.USDC).toBe("99950");
    expect(result.current.state.dvpTrades[0]).toMatchObject({
      status: "funded",
      legs: {
        a: { funding: { funded: true } },
        b: { funding: { funded: true } },
      },
    });

    act(() => result.current.actOnDvpTrade(trade.id, "settle"));

    expect(result.current.state.balances.USDT).toBe("100050");
    expect(result.current.state.dvpTrades[0]?.status).toBe("settled");
  });

  it("rejects malformed LocalStorage state instead of trusting it", () => {
    expect(
      parseMarketsSandboxState({
        version: 1,
        balances: { SOL: "infinite", USDC: "0", USDG: "0", USDT: "0", PYUSD: "0" },
        positions: [],
        activity: [],
        dvpTrades: [],
      })
    ).toBeNull();
  });
});
