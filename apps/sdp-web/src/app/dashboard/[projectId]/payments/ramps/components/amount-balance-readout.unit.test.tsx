// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AmountBalanceReadout } from "./amount-balance-readout";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("AmountBalanceReadout", () => {
  it("says the balance is unavailable instead of showing zero", () => {
    render(<AmountBalanceReadout available={null} assetLabel="USDC" exceeds={false} />, {
      wrapper,
    });

    expect(screen.getByText("Balance unavailable")).toBeTruthy();
    expect(screen.queryByText(/0 USDC/)).toBeNull();
    expect(screen.queryByRole("button", { name: "MAX" })).toBeNull();
  });

  it("shows a read balance with Max", () => {
    render(
      <AmountBalanceReadout available="5" assetLabel="USDC" exceeds={false} onMax={vi.fn()} />,
      { wrapper }
    );

    expect(screen.getByText("5 USDC")).toBeTruthy();
    expect(screen.getByRole("button", { name: "MAX" })).toBeTruthy();
  });
});
