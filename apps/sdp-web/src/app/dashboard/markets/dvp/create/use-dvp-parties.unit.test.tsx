// @vitest-environment jsdom

/**
 * Who the two parties are, and which shape the request takes.
 *
 * The two kinds describe the parties differently, and the difference decides
 * which leg (if any) SDP funds. A principal trade that lost its side, or an
 * agent trade that carried one, would name a leg this organization has no key
 * for — so `request` is null unless the chosen shape is complete.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DvpCreateWallet } from "./dvp-create.data";
import { useDvpParties } from "./use-dvp-parties";

const WALLET_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const OTHER = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const THIRD = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

const wallets: DvpCreateWallet[] = [
  { id: "cwlt_1", address: WALLET_ADDRESS, label: "Treasury", balances: [] },
];

function setup() {
  return renderHook(() => useDvpParties(wallets, "cwlt_1"));
}

describe("useDvpParties", () => {
  it("starts as a principal trade, which is the default shape", () => {
    const { result } = setup();

    expect(result.current.tradeKind).toBe("principal");
    expect(result.current.ready).toBe(false);
  });

  it("resolves a principal trade to a side and a counterparty", () => {
    const { result } = setup();
    act(() => result.current.setCounterparty(OTHER));

    expect(result.current.ready).toBe(true);
    expect(result.current.request).toEqual({
      tradeKind: "principal",
      sdpSide: "a",
      counterparty: OTHER,
    });
  });

  // A trade needs two parties. The program refuses one address on both sides,
  // and catching it here saves a round trip that costs a provider call.
  it("refuses a counterparty that is the wallet funding your own leg", () => {
    const { result } = setup();
    act(() => result.current.setCounterparty(WALLET_ADDRESS));

    expect(result.current.counterpartyIsOwnLegWallet).toBe(true);
    expect(result.current.ready).toBe(false);
    expect(result.current.request).toBeNull();
  });

  it("resolves an agent trade to two parties and NO side", () => {
    const { result } = setup();
    act(() => result.current.setTradeKind("agent"));
    act(() => {
      result.current.setPartyA(OTHER);
      result.current.setPartyB(THIRD);
    });

    expect(result.current.request).toEqual({
      tradeKind: "agent",
      partyA: OTHER,
      partyB: THIRD,
    });
    // Naming a side would claim a leg this organization holds no key for.
    expect(result.current.request).not.toHaveProperty("sdpSide");
  });

  it("refuses an agent trade whose two parties are the same address", () => {
    const { result } = setup();
    act(() => result.current.setTradeKind("agent"));
    act(() => {
      result.current.setPartyA(OTHER);
      result.current.setPartyB(OTHER);
    });

    expect(result.current.partiesAreSame).toBe(true);
    expect(result.current.request).toBeNull();
  });

  it("refuses a malformed party address", () => {
    const { result } = setup();
    act(() => result.current.setTradeKind("agent"));
    act(() => {
      result.current.setPartyA("not-an-address");
      result.current.setPartyB(THIRD);
    });

    expect(result.current.partyALooksWrong).toBe(true);
    expect(result.current.request).toBeNull();
  });

  // The counterparty typed for a principal trade must not leak into an agent
  // request, and vice versa: they describe different trades.
  it("switching kind changes which fields decide readiness", () => {
    const { result } = setup();
    act(() => result.current.setCounterparty(OTHER));
    expect(result.current.ready).toBe(true);

    act(() => result.current.setTradeKind("agent"));
    expect(result.current.ready).toBe(false);
    expect(result.current.request).toBeNull();
  });
});
