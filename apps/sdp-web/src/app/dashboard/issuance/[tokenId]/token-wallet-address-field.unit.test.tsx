// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TokenWalletAddressField } from "./token-wallet-address-field";

const address = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";
const wallet: PaymentsDashboardWallet = {
  id: "wallet_test",
  walletId: "wallet_test",
  label: "Treasury",
  publicKey: address,
};

function Harness({ error }: { error?: string }) {
  const [value, setValue] = useState("");
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <form>
        <TokenWalletAddressField
          label="Destination"
          value={value}
          onChange={setValue}
          walletOptions={[wallet]}
          required
          pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"
          title="Enter a valid wallet address"
          error={error}
        />
      </form>
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("TokenWalletAddressField", () => {
  it("clears a previous required error when a saved wallet is selected", () => {
    const view = render(<Harness />);
    const input = view.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    fireEvent.invalid(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.focus(input);
    fireEvent.click(view.getByRole("button", { name: /Treasury/ }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(view.queryByText("Destination is required.")).toBeNull();
    expect(view.getByDisplayValue(address)).toBe(input);
  });

  it("still validates required and malformed addresses after clearing a selection", () => {
    const view = render(<Harness />);
    const input = view.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.click(view.getByRole("button", { name: /Treasury/ }));
    fireEvent.click(view.getByRole("button", { name: /Clear destination/i }));
    expect(input.hasAttribute("required")).toBe(true);
    fireEvent.invalid(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "invalid" } });
    expect(view.getByText("Enter a valid wallet address")).toBeTruthy();
    fireEvent.change(input, { target: { value: address } });
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("preserves business-validation errors when choosing a wallet", () => {
    const view = render(<Harness error="Recipient is blocked" />);
    const input = view.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.click(view.getByRole("button", { name: /Treasury/ }));
    expect(view.getByText("Recipient is blocked")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});
