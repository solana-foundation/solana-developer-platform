// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as custodyActions from "../actions";
import type { WalletPageView } from "./wallet-detail.shared";
import { WalletSettingsTab } from "./wallet-settings-tab";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: false } },
    sandboxProject: null,
  }),
}));

const WALLET: WalletPageView = {
  walletId: "wal_settings_test",
  custodyWalletId: "cw_settings_test",
  name: "Treasury",
  publicKey: "11111111111111111111111111111111",
  provider: "turnkey",
  providerName: "Turnkey",
  purposeLabel: null,
  createdAt: null,
  isRuntimeExecutionAllowed: true,
  supportsSignerCheck: false,
  connection: null,
  canManageCustody: true,
  label: "Treasury",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalletSettingsTab label", () => {
  it("saves the label under an Idempotency-Key, and a retry after a lost answer reuses it", async () => {
    const updateLabel = vi
      .spyOn(custodyActions, "updateWalletLabelAction")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ status: "success", label: "Settlement" });
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <WalletSettingsTab wallet={WALLET} />
      </I18nProvider>
    );
    fireEvent.change(screen.getByLabelText("Wallet label"), {
      target: { value: "Settlement" },
    });
    const save = screen.getByRole("button", { name: "Save changes" });
    await act(async () => {
      fireEvent.click(save);
    });
    await act(async () => {
      fireEvent.click(save);
    });

    const [first, retry] = updateLabel.mock.calls;
    expect(first?.slice(0, 2)).toEqual(["wal_settings_test", "Settlement"]);
    expect(first?.[2]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(retry?.[2]).toBe(first?.[2]);
  });
});
