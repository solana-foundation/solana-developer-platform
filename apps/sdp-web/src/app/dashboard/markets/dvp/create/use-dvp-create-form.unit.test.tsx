// @vitest-environment jsdom

/**
 * The create form's derived state.
 *
 * Two things here decide whether the right amount moves: the human-to-base-unit
 * conversion, and the readiness gate that stops a submit while either leg is
 * unresolved. Both are checked through the hook rather than the helpers they
 * call, because the bug worth catching is the wiring.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DvpCreateContext } from "./dvp-create.data";
import { useDvpCreateForm } from "./use-dvp-create-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COUNTERPARTY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

const context: DvpCreateContext = {
  error: null,
  wallets: [
    { id: "cwlt_1", address: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn", label: "Treasury" },
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
  return renderHook(() => useDvpCreateForm("devnet", ctx));
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

  // With no issued tokens the asset leg falls back to a pasted mint, and the
  // form has to stay usable rather than becoming permanently un-submittable.
  it("resolves a pasted mint when the organization has issued nothing", () => {
    const { result } = setup({ ...context, tokens: [] });

    act(() => result.current.asset.setCustom("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"));
    act(() => result.current.setCounterparty(COUNTERPARTY));
    // No decimals are known for a pasted mint, so the field takes base units
    // directly rather than guessing a scale.
    act(() => result.current.asset.setAmount("1000"));
    act(() => result.current.cash.setAmount("25"));

    expect(result.current.asset.baseUnits).toBe("1000");
    expect(result.current.ready).toBe(true);
  });
});
