// @vitest-environment jsdom

/**
 * The scale a pasted mint's amount is encoded with.
 *
 * This is a money bug, not a polish one. `usePastedMint` debounces by 350ms,
 * and it used to keep the previously resolved mint's metadata for that whole
 * window while the leg already pointed at the new address. Submitting inside it
 * encoded the amount with the WRONG token's decimals. Once loading did clear
 * them, the fallback treated the typed human amount as base units instead. Both
 * put a different quantity on chain than the one someone typed, and nothing
 * blocked submit in either state.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM, useDvpLeg } from "./use-dvp-leg";
import type { PastedMintState } from "./use-pasted-mint";

const pastedState = vi.hoisted(() => ({ current: null as PastedMintState | null }));
vi.mock("./use-pasted-mint", () => ({
  usePastedMint: () => pastedState.current,
}));

const MINT_A = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";
const MINT_B = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function resolved(address: string, decimals: number): PastedMintState {
  return {
    address,
    loading: false,
    notFound: false,
    mint: {
      decimals,
      name: null,
      symbol: "X",
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      eligible: true,
      blockedBy: null,
    },
  };
}

function leg(state: PastedMintState, typed: string, amount: string) {
  pastedState.current = state;
  const { result, rerender } = renderHook(() => useDvpLeg([]));
  result.current.setChoice(CUSTOM);
  result.current.setCustom(typed);
  result.current.setAmount(amount);
  rerender();
  return result;
}

describe("a pasted leg whose lookup has not caught up", () => {
  // The exact reported case: metadata resolved for MINT_A while the field now
  // holds MINT_B.
  it("does not scale by a previous mint's decimals", () => {
    const result = leg(resolved(MINT_A, 9), MINT_B, "1000");

    expect(result.current.decimalsKnown).toBe(false);
    expect(result.current.pendingLookup).toBe(true);
  });

  it("does not borrow a previous mint's symbol either", () => {
    const result = leg(resolved(MINT_A, 9), MINT_B, "1000");

    expect(result.current.symbol).toBe("");
  });

  it("blocks while a lookup for the current address is in flight", () => {
    const result = leg(
      { address: MINT_B, loading: true, notFound: false, mint: null },
      MINT_B,
      "1000"
    );

    expect(result.current.pendingLookup).toBe(true);
  });

  // Once the answer belongs to the address on screen, the leg is usable and the
  // amount is scaled by that mint's own decimals.
  it("uses metadata that belongs to the address typed", () => {
    const result = leg(resolved(MINT_B, 6), MINT_B, "1000");

    expect(result.current.pendingLookup).toBe(false);
    expect(result.current.decimalsKnown).toBe(true);
    expect(result.current.baseUnits).toBe("1000000000");
  });

  // A listed token carries its own decimals and never waits on a lookup.
  it("never waits when the mint came from the list", () => {
    pastedState.current = { address: "", loading: true, notFound: false, mint: null };
    const { result } = renderHook(() =>
      useDvpLeg([
        {
          mint: MINT_A,
          label: "ATD",
          decimals: 6,
          tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        },
      ])
    );

    expect(result.current.pendingLookup).toBe(false);
  });
});
