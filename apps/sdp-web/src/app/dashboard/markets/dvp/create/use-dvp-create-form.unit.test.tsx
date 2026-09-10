// @vitest-environment jsdom

/**
 * The create form's derived state.
 *
 * Two things here decide whether the right amount moves: the human-to-base-unit
 * conversion, and the readiness gate that stops a submit while either leg is
 * unresolved or a party slot is empty. Both are checked through the hook rather
 * than the helpers they call, because the bug worth catching is the wiring.
 */

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpCreateContext } from "./dvp-create.data";
import { useDvpCreateForm } from "./use-dvp-create-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function withI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];
const WALLET_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const PARTY_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const ASSET_MINT = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1";

const context: DvpCreateContext = {
  error: null,
  wallets: [
    {
      id: "cwlt_1",
      address: WALLET_ADDRESS,
      label: "Treasury",
      balances: [],
    },
  ],
  counterpartyAccounts: [],
  tokens: [
    {
      mint: ASSET_MINT,
      label: "TBOND",
      name: "Test Bond",
      decimals: 6,
      tokenProgram: TOKEN_2022,
    },
  ],
};

/** Fills both party slots with pasted addresses; neither is preselected. */
function fillParties(result: ReturnType<typeof setup>["result"]) {
  act(() => result.current.setParty("a", { mode: "address", address: WALLET_ADDRESS }));
  act(() => result.current.setParty("b", { mode: "address", address: PARTY_B }));
}

function setup(ctx: DvpCreateContext = context) {
  return renderHook(() => useDvpCreateForm("devnet", ctx), { wrapper: withI18n });
}

describe("useDvpCreateForm", () => {
  // The asset and both parties are the trade's whole point, so they start
  // unselected; only the cash leg preselects the cluster's first stablecoin,
  // which is almost always the answer.
  it("starts with both parties and the asset unselected, only the cash mint preset", () => {
    const { result } = setup();

    expect(result.current.values.partyA).toEqual({ mode: "address", address: "" });
    expect(result.current.values.partyB).toEqual({ mode: "address", address: "" });
    expect(result.current.asset.token).toBeNull();
    expect(result.current.asset.mint).toBe("");
    expect(result.current.cash.token).not.toBeNull();
  });

  it("offers stablecoins for the cash leg on this cluster", () => {
    const { result } = setup();

    expect(result.current.cashOptions.length).toBeGreaterThan(0);
    expect(result.current.cashOptions.every((option) => option.mint && option.tokenProgram)).toBe(
      true
    );
  });

  // The API takes base units. Sending "10" for a 6-decimal mint would move a
  // millionth of the intended amount.
  it("converts a typed amount into base units", () => {
    const { result } = setup();

    act(() => result.current.asset.setChoice(ASSET_MINT));
    act(() => result.current.asset.setAmount("10.5"));

    expect(result.current.asset.baseUnits).toBe("10500000");
  });

  // Truncating would move a different amount than the one on screen, so the
  // form refuses rather than rounding.
  it("refuses to resolve an amount finer than the mint allows", () => {
    const { result } = setup();

    act(() => result.current.asset.setChoice(ASSET_MINT));
    act(() => result.current.asset.setAmount("1.9999999"));

    expect(result.current.asset.baseUnits).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("is not ready while a party slot is unfilled", () => {
    const { result } = setup();

    expect(result.current.partiesReady).toBe(false);
    expect(result.current.ready).toBe(false);
  });

  it("refuses an address slot that is not a Solana address", () => {
    const { result } = setup();

    act(() => result.current.setParty("b", { mode: "address", address: "not-an-address" }));

    expect(result.current.partiesReady).toBe(false);
    expect(result.current.ready).toBe(false);
  });

  it("becomes ready once both legs and both parties are set", () => {
    const { result } = setup();

    fillParties(result);
    act(() => result.current.asset.setChoice(ASSET_MINT));
    act(() => result.current.asset.setAmount("10"));
    act(() => result.current.cash.setAmount("25"));

    expect(result.current.ready).toBe(true);
  });

  /**
   * With no issued tokens the asset leg falls back to a pasted mint, and the
   * form has to stay usable rather than becoming permanently un-submittable.
   *
   * It must NOT be usable while the lookup is still running, which is what this
   * previously asserted: the mint's scale is unknown in that window, so the
   * amount would be encoded either by a previous mint's decimals or as raw base
   * units, and both send a different quantity than the one typed. Once the
   * lookup settles with nothing, the documented base-unit fallback applies and
   * the form is submittable again.
   */
  it("holds a pasted mint un-submittable until its lookup settles", async () => {
    const { result } = setup({ ...context, tokens: [] });

    act(() => result.current.asset.setCustom("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"));
    fillParties(result);
    act(() => result.current.asset.setAmount("1000"));
    act(() => result.current.cash.setAmount("25"));

    expect(result.current.asset.pendingLookup).toBe(true);
    expect(result.current.ready).toBe(false);

    // And still not ready once it settles with nothing. There is no base-unit
    // fallback: "no scale" used to mean "read the typed number as base units",
    // which covered a lookup that FAILED as well as a mint with no metadata,
    // so a network error silently turned 1000 tokens into 0.001 of one.
    await waitFor(() => expect(result.current.asset.pendingLookup).toBe(false));

    expect(result.current.asset.baseUnits).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  /**
   * The balance the delivering leg spends from.
   *
   * A balance belongs to the wallet NAMED IN THAT LEG'S SLOT — the asset leg
   * reads the asset party's wallet, the cash leg the cash party's. The zero
   * case is the one that matters: a wallet holding none of the mint has no
   * entry in `balances` at all, and reading that as "unknown" would drop the
   * balance row and the over-balance guard with it.
   */
  describe("the delivering leg's balance", () => {
    const held = {
      ...context,
      wallets: [
        {
          ...context.wallets[0],
          balances: [{ mint: ASSET_MINT, amount: "25000000000", decimals: 6, symbol: "TBOND" }],
        },
      ],
    };

    it("reports what the asset slot's wallet holds of the asset mint", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), {
        wrapper: withI18n,
      });

      act(() => result.current.setParty("a", { mode: "wallet", walletId: "cwlt_1" }));
      act(() => result.current.asset.setChoice(ASSET_MINT));

      expect(result.current.assetBalance).toMatchObject({ amount: "25000000000", decimals: 6 });
    });

    it("reports zero, not unknown, when the wallet holds none of it", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", context), {
        wrapper: withI18n,
      });

      act(() => result.current.setParty("a", { mode: "wallet", walletId: "cwlt_1" }));
      act(() => result.current.asset.setChoice(ASSET_MINT));

      expect(result.current.assetBalance).toMatchObject({ amount: "0", decimals: 6 });
    });

    // The asset slot names a wallet that is not the cash leg's, and a pasted
    // cash party has no wallet at all — showing a balance against the cash leg
    // would claim we hold what the other party owes.
    it("reports nothing for a leg whose slot names no wallet", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), {
        wrapper: withI18n,
      });

      expect(result.current.cashBalance).toBeNull();
    });

    it("follows the wallet named in the cash slot", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), {
        wrapper: withI18n,
      });

      act(() => result.current.setParty("a", { mode: "address", address: PARTY_B }));
      act(() => result.current.setParty("b", { mode: "wallet", walletId: "cwlt_1" }));

      expect(result.current.assetBalance).toBeNull();
      expect(result.current.cashBalance).not.toBeNull();
    });
  });
});
