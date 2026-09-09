// @vitest-environment jsdom

/**
 * The create form's derived state.
 *
 * Two things here decide whether the right amount moves: the human-to-base-unit
 * conversion, and the readiness gate that stops a submit while either leg is
 * unresolved. Both are checked through the hook rather than the helpers they
 * call, because the bug worth catching is the wiring.
 */

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

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COUNTERPARTY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

const context: DvpCreateContext = {
  error: null,
  wallets: [
    {
      id: "cwlt_1",
      address: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
      label: "Treasury",
      balances: [],
    },
  ],
  tokens: [
    {
      mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
      label: "TBOND",
      decimals: 6,
      tokenProgram: TOKEN_2022,
    },
  ],
};

function setup(ctx: DvpCreateContext = context) {
  return renderHook(() => useDvpCreateForm("devnet", ctx), { wrapper: withI18n });
}

describe("useDvpCreateForm", () => {
  it("preselects the first wallet and the first issued token", () => {
    const { result } = setup();

    expect(result.current.walletId).toBe("cwlt_1");
    expect(result.current.asset.token?.label).toBe("TBOND");
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

    act(() => result.current.asset.setAmount("10.5"));

    expect(result.current.asset.baseUnits).toBe("10500000");
  });

  // Truncating would move a different amount than the one on screen, so the
  // form refuses rather than rounding.
  it("refuses to resolve an amount finer than the mint allows", () => {
    const { result } = setup();

    act(() => result.current.asset.setAmount("1.9999999"));

    expect(result.current.asset.baseUnits).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("flags a counterparty that is not a Solana address", () => {
    const { result } = setup();

    act(() => result.current.setCounterparty("not-an-address"));

    expect(result.current.counterpartyLooksWrong).toBe(true);
    expect(result.current.ready).toBe(false);
  });

  // An empty field is not a wrong one. Complaining before anything is typed is
  // noise, not help.
  it("does not flag an empty counterparty", () => {
    const { result } = setup();

    expect(result.current.counterpartyLooksWrong).toBe(false);
  });

  it("becomes ready once both legs and a valid counterparty are set", () => {
    const { result } = setup();

    act(() => result.current.setCounterparty(COUNTERPARTY));
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
    act(() => result.current.setCounterparty(COUNTERPARTY));
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
   * The zero case is the one that matters: a wallet holding none of the mint has
   * no entry in `balances` at all, and reading that as "unknown" would drop the
   * balance row and the over-balance guard with it — so switching to a wallet
   * that cannot deliver the leg would look exactly like one that can.
   */
  describe("the delivering leg's balance", () => {
    const held = {
      ...context,
      wallets: [
        {
          ...context.wallets[0],
          balances: [
            {
              mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
              amount: "25000000000",
              decimals: 6,
              symbol: "TBOND",
            },
          ],
        },
      ],
    };

    it("reports what the wallet holds of the asset leg", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), { wrapper: withI18n });

      expect(result.current.assetBalance).toMatchObject({ amount: "25000000000", decimals: 6 });
    });

    it("reports zero, not unknown, when the wallet holds none of it", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", context), {
        wrapper: withI18n,
      });

      expect(result.current.assetBalance).toMatchObject({ amount: "0", decimals: 6 });
    });

    // The counterparty's leg is funded by them. Showing our balance against it
    // would claim we hold what they owe.
    it("reports nothing for the leg SDP does not deliver", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), { wrapper: withI18n });

      expect(result.current.cashBalance).toBeNull();
    });

    it("follows the side SDP takes", () => {
      const { result } = renderHook(() => useDvpCreateForm("devnet", held), { wrapper: withI18n });

      act(() => {
        result.current.setSdpSide("b");
      });

      expect(result.current.assetBalance).toBeNull();
      expect(result.current.cashBalance).not.toBeNull();
    });
  });
});
