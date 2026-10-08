// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AmountFields, type AmountTokenControls, SourceWalletField } from "./payment-form-fields";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const token: AmountTokenControls = {
  value: "",
  onChange: vi.fn(),
  options: [{ value: "usdc", label: "USDC" }],
  placeholder: "Select a token",
  disabled: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SourceWalletField", () => {
  it("labels the picker and shows the flow's note under it", () => {
    render(
      <SourceWalletField value="" onChange={vi.fn()} options={[]} disabled>
        <p>Signing is off for this wallet.</p>
      </SourceWalletField>,
      { wrapper }
    );

    expect(screen.getByRole("button", { name: "Source wallet" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Signing is off for this wallet.")).not.toBeNull();
  });
});

describe("AmountFields", () => {
  it("reports the typed amount as a string", async () => {
    const onChange = vi.fn();
    render(<AmountFields id="amount" label="Amount" value="" onChange={onChange} token={token} />, {
      wrapper,
    });

    await userEvent.setup().type(screen.getByRole("spinbutton", { name: "Amount" }), "5");

    expect(onChange).toHaveBeenCalledWith("5");
    expect(screen.getByRole("button", { name: "Token" })).toHaveProperty("disabled", false);
  });

  it("offers Max only when the flow can fill in the balance", async () => {
    const onMax = vi.fn();
    const { rerender } = render(
      <AmountFields id="amount" label="Amount" value="" onChange={vi.fn()} token={token} />,
      { wrapper }
    );
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();

    rerender(
      <AmountFields
        id="amount"
        label="Amount"
        value=""
        onChange={vi.fn()}
        onMax={onMax}
        token={token}
      />
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Max" }));

    expect(onMax).toHaveBeenCalledOnce();
  });

  it("drops input past the token's decimals", async () => {
    const onChange = vi.fn();
    render(
      <AmountFields
        id="amount"
        label="Amount"
        value="1.2"
        onChange={onChange}
        maxDecimals={1}
        token={token}
      />,
      { wrapper }
    );

    await userEvent.setup().type(screen.getByRole("spinbutton", { name: "Amount" }), "5");

    expect(onChange).not.toHaveBeenCalled();
  });
});
