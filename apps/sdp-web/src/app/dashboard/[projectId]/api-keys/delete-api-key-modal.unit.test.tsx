// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as apiKeyActions from "./actions";
import { DeleteApiKeyModal } from "./delete-api-key-modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeleteApiKeyModal", () => {
  it.each([false, true])(
    "asks to cancel the key's payment requests only when its box is checked: %s",
    async (checked) => {
      const deactivate = vi
        .spyOn(apiKeyActions, "deactivateApiKeyInlineAction")
        .mockResolvedValue({ ok: true, message: "Deleted" });
      const user = userEvent.setup();
      render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <DeleteApiKeyModal keyId="key_1" keyName="Payouts worker" open onOpenChange={() => {}} />
        </I18nProvider>
      );

      await user.type(screen.getByLabelText("Confirm key name"), "Payouts worker");
      if (checked) {
        await user.click(
          screen.getByRole("checkbox", {
            name: /Also cancel open payment requests this key created/,
          })
        );
      }
      await user.click(screen.getByRole("button", { name: "Delete key" }));

      await waitFor(() =>
        expect(deactivate).toHaveBeenCalledWith({
          keyId: "key_1",
          keyName: "Payouts worker",
          confirmation: "Payouts worker",
          cancelRecurringPayments: false,
          cancelPaymentRequests: checked,
        })
      );
    }
  );
});
