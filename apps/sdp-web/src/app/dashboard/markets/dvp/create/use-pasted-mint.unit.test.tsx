// @vitest-environment jsdom

/**
 * Resolving a pasted mint, and never answering for the wrong one.
 *
 * The hazard this guards is a money bug: the amount a leg sends is scaled by
 * the resolved mint's decimals, so metadata belonging to a PREVIOUS address is
 * not slightly stale, it is a different token and a different quantity on
 * chain. `use-dvp-leg.unit.test.tsx` covers the consumer's side of that; these
 * cover the hook's own contract, which is that an address that has not been
 * answered yet reads as null and loading rather than as the last answer.
 */

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePastedMint } from "./use-pasted-mint";

const MINT_A = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";
const MINT_B = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEBOUNCE_MS = 350;

function mintBody(decimals: number) {
  return {
    ok: true,
    json: async () => ({
      data: {
        mint: {
          decimals,
          name: null,
          symbol: null,
          tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
          eligible: true,
          blockedBy: null,
        },
      },
    }),
  };
}

/** Runs the debounce and lets the awaited fetch/json microtasks settle. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePastedMint", () => {
  it("stays idle for an address too short to be one", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePastedMint("abc"));

    expect(result.current).toMatchObject({ mint: null, loading: false, notFound: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a pasted mint and reports its decimals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintBody(6)));

    const { result } = renderHook(() => usePastedMint(MINT_A));

    expect(result.current.loading).toBe(true);
    await settle();

    expect(result.current.mint?.decimals).toBe(6);
    expect(result.current.address).toBe(MINT_A);
    expect(result.current.loading).toBe(false);
  });

  // The regression. Replacing the address must invalidate the previous answer
  // on the SAME render, not after the effect or after the debounce.
  it("never reports the previous mint once the address changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mintBody(6)));

    const { result, rerender } = renderHook(({ a }) => usePastedMint(a), {
      initialProps: { a: MINT_A },
    });
    await settle();
    expect(result.current.mint?.decimals).toBe(6);

    rerender({ a: MINT_B });

    // Read immediately, before any timer or effect work: the old decimals must
    // already be gone, or an amount submitted here is scaled by the wrong token.
    expect(result.current.mint).toBeNull();
    expect(result.current.address).toBe(MINT_B);
    expect(result.current.loading).toBe(true);
  });

  it("reports notFound for an address that resolves to nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { result } = renderHook(() => usePastedMint(MINT_A));
    await settle();

    expect(result.current).toMatchObject({ mint: null, loading: false, notFound: true });
  });

  // A failed lookup is not a mint without metadata. It must not read as
  // notFound, and it must never produce a scale.
  it("leaves a failed lookup without a scale rather than guessing one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { result } = renderHook(() => usePastedMint(MINT_A));
    await settle();

    expect(result.current).toMatchObject({ mint: null, loading: false, notFound: false });
  });
});
