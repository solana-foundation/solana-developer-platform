// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as custodyActions from "./actions";
import { WalletActionsMenu } from "./wallet-actions-menu";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "prj_sandbox" },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalletActionsMenu signer check", () => {
  // The check signs in simulation and broadcasts nothing. Under a kept key a
  // press after the user fixed the signer would replay the earlier failure.
  it("probes the signer afresh on every press, under no Idempotency-Key", async () => {
    vi.spyOn(toast, "loading").mockImplementation(() => "toast");
    vi.spyOn(toast, "success").mockImplementation(() => "toast");
    vi.spyOn(toast, "error").mockImplementation(() => "toast");
    const check = vi
      .spyOn(custodyActions, "checkWalletSignerMemoAction")
      .mockResolvedValueOnce({ status: "error", message: "signer unreachable" })
      .mockResolvedValueOnce({ status: "success", walletId: "wallet_1", signature: "sig" });
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <WalletActionsMenu
          walletAddress="11111111111111111111111111111111"
          walletId="wallet_1"
          walletLabel="Ops"
        />
      </I18nProvider>
    );
    const user = userEvent.setup();
    const trigger = () => screen.getByRole("button", { name: "Wallet actions for Ops" });
    const prove = async () => {
      await waitFor(() => expect(trigger().hasAttribute("disabled")).toBe(false));
      await user.click(trigger());
      await user.click(await screen.findByRole("menuitem", { name: "Prove ownership" }));
    };

    await prove();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await prove();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));

    expect(check.mock.calls).toEqual([["wallet_1"], ["wallet_1"]]);
  });
});
