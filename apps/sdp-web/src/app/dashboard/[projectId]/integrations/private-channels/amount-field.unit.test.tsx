// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: This test double forwards associations supplied by the component.
    <label {...props} />
  ),
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AmountField } from "./amount-field";

function renderField(props: Partial<ComponentProps<typeof AmountField>> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(
    <AmountField
      id="amount"
      onChange={() => {}}
      spends="channel"
      symbol="USDC"
      value=""
      {...props}
    />,
    { wrapper }
  );
}

afterEach(cleanup);

describe("AmountField", () => {
  it("lists the balance the flow spends first", () => {
    renderField({ balances: { channel: "10", onChain: "5" }, spends: "onChain" });

    const balanceRow = screen.getByText(/On-chain:/).parentElement;
    expect(balanceRow?.textContent).toBe("On-chain: 5 USDCChannel balance: 10 USDC");
  });

  it("omits a balance that could not be read", () => {
    renderField({ balances: { channel: "10", onChain: null } });

    expect(screen.getByText(/Channel balance:/)).toBeTruthy();
    expect(screen.queryByText(/On-chain:/)).toBeNull();
  });

  it("replaces the balances with the amount problem and marks the input invalid", () => {
    renderField({
      balances: { channel: "10", onChain: "5" },
      error: "Enter a USDC amount greater than zero with up to 6 decimal places.",
    });

    const input = screen.getByLabelText("Amount (USDC)");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("amount-error");
    expect(screen.getByText(/greater than zero/)).toBeTruthy();
    expect(screen.queryByText(/Channel balance:/)).toBeNull();
  });
});
