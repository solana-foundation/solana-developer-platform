// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TokenActionConfirmationDialog } from "./token-action-confirmation-dialog";
import type { ActionConfirmationState } from "./token-management-workspace.types";

const confirmation: ActionConfirmationState = {
  input: { label: "Unpause", method: "POST", path: "/unpause", body: {} },
  options: {
    confirmationTitle: "Unpause token",
    confirmationDescription: "Resume transfers.",
    confirmButtonLabel: "Unpause now",
    submitToast: "Submitting",
    successToast: "Done",
  },
  signerWallets: [
    { id: "cwlt_a", walletId: "provider_same", publicKey: "address", label: "Config" },
    { id: "cwlt_b", walletId: "provider_same", publicKey: "address", label: "Connection" },
  ],
};

afterEach(cleanup);

describe("Unpause confirmation", () => {
  it("requires the selected wallet to belong to the displayed candidates", () => {
    const onConfirm = vi.fn();
    function view(signingCustodyWalletId?: string) {
      return (
        <I18nProvider locale="en" messages={getMessages("en")}>
          <TokenActionConfirmationDialog
            actionConfirmation={{ ...confirmation, signingCustodyWalletId }}
            isPending={false}
            onCancel={vi.fn()}
            onConfirm={onConfirm}
            onSignerWalletIdChange={vi.fn()}
          />
        </I18nProvider>
      );
    }
    const rendered = render(view());
    const confirm = () => screen.getByRole("button", { name: "Unpause now" });
    expect(confirm().hasAttribute("disabled")).toBe(true);
    rendered.rerender(view("cwlt_missing"));
    expect(confirm().hasAttribute("disabled")).toBe(true);
    rendered.rerender(view("cwlt_b"));
    expect(confirm().hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
