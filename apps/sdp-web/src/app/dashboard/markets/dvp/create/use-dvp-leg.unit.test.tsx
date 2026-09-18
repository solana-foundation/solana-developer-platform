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

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
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
      tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
      eligible: true,
      blockedBy: null,
    },
  };
}

function leg(state: PastedMintState, typed: string, amount: string) {
  pastedState.current = state;
  const { result, rerender } = renderHook(() => useDvpLeg([], false));
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

    expect(result.current.decimals).toBeNull();
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
    expect(result.current.decimals).toBe(6);
    expect(result.current.baseUnits).toBe("1000000000");
  });

  // A listed token carries its own decimals, so it never waits for a scale.
  // It does wait for its eligibility answer, which the block below covers.
  it("keeps a listed token's own decimals while its answer is outstanding", () => {
    pastedState.current = { address: MINT_A, loading: true, notFound: false, mint: null };
    const { result } = renderHook(() =>
      useDvpLeg(
        [
          {
            mint: MINT_A,
            label: "ATD",
            name: null,
            decimals: 6,
            tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
          },
        ],
        true
      )
    );

    expect(result.current.decimals).toBe(6);
  });
});

/**
 * PRO-1951. A mint create refuses, such as one with a transfer hook, is ruled
 * out at the field rather than by a 400 on submit. Listed tokens are read too:
 * an issued token can carry a hook, and the list says nothing about extensions.
 */
describe("a leg on a mint create would refuse", () => {
  const LISTED = {
    mint: MINT_A,
    label: "ATD",
    name: null,
    decimals: 6,
    tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
  };

  function refused(address: string, blockedBy: string | null): PastedMintState {
    const state = resolved(address, 6);
    return { ...state, mint: state.mint && { ...state.mint, eligible: false, blockedBy } };
  }

  it("rules out a pasted mint and names the extension", () => {
    const result = leg(refused(MINT_B, "TransferHook"), MINT_B, "10");

    expect(result.current.ineligible).toBe(true);
    expect(result.current.blockedBy).toBe("TransferHook");
  });

  it("rules out a listed token the inspection refuses", () => {
    pastedState.current = refused(MINT_A, "TransferHook");
    const { result } = renderHook(() => useDvpLeg([LISTED], true));

    expect(result.current.ineligible).toBe(true);
    expect(result.current.pendingLookup).toBe(false);
  });

  it("does not rule out a mint by an answer for a different one", () => {
    const result = leg(refused(MINT_A, "TransferHook"), MINT_B, "10");

    expect(result.current.ineligible).toBe(false);
    expect(result.current.blockedBy).toBeNull();
  });

  // Its decimals are known, but its eligibility is not, and a form that is
  // ready before that answer lands lets a refused mint reach the API instead
  // of the field.
  it("waits for a listed token's eligibility answer", () => {
    pastedState.current = { address: MINT_A, loading: true, notFound: false, mint: null };
    const { result } = renderHook(() => useDvpLeg([LISTED], true));

    expect(result.current.pendingLookup).toBe(true);
  });

  it("stops waiting once the listed token's answer arrives", () => {
    pastedState.current = {
      address: MINT_A,
      loading: false,
      notFound: false,
      mint: {
        decimals: 6,
        symbol: null,
        name: null,
        tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
        eligible: true,
        blockedBy: null,
      },
    };
    const { result } = renderHook(() => useDvpLeg([LISTED], true));

    expect(result.current.pendingLookup).toBe(false);
    expect(result.current.ineligible).toBe(false);
  });

  // Unread is not refused. The API still refuses at create, so the field makes
  // no claim it cannot back.
  it("claims nothing while a listed token is unread", () => {
    pastedState.current = { address: MINT_A, loading: true, notFound: false, mint: null };
    const { result } = renderHook(() => useDvpLeg([LISTED], true));

    expect(result.current.ineligible).toBe(false);
  });
});
