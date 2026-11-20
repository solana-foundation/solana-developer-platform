// @vitest-environment jsdom

import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as custodyActions from "@/app/(session)/dashboard/[projectId]/wallets/actions";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { stubClerkSession } from "@/test/clerk";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { syntheticWalletAddress } from "@/test/wallets";
import type { WalletPageView } from "./wallet-detail.shared";
import { WalletSettingsTab } from "./wallet-settings-tab";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLET: WalletPageView = {
  walletId: "wal_settings_test",
  custodyWalletId: "cw_settings_test",
  name: "Treasury",
  publicKey: syntheticWalletAddress(1),
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

function renderSettings(wallet: WalletPageView, releaseChannel: SdpReleaseChannel = "stable") {
  render(
    <EnglishI18n>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess(wallet.canManageCustody ? "admin" : "member")}
        flags={dashboardFlagsAt(releaseChannel)}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
      >
        <WalletSettingsTab wallet={wallet} />
      </DashboardWorkspaceProvider>
    </EnglishI18n>
  );
}

beforeEach(() => {
  stubClerkSession();
  resetDashboardNavigation();
  window.sessionStorage.clear();
});

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
    renderSettings(WALLET);
    fireEvent.change(screen.getByLabelText("Wallet label"), {
      target: { value: "Settlement" },
    });
    const save = screen.getByRole("button", { name: /^Save changes/ });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(save);
    });

    const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/);
    expect(updateLabel.mock.calls).toEqual([
      ["wal_settings_test", "Settlement", uuid],
      ["wal_settings_test", "Settlement", uuid],
    ]);
    expect(new Set(updateLabel.mock.calls.map(([, , key]) => key)).size).toBe(1);
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses to save a blank label", () => {
    const updateLabel = vi.spyOn(custodyActions, "updateWalletLabelAction");
    renderSettings(WALLET);
    const field = screen.getByLabelText("Wallet label");
    fireEvent.change(field, { target: { value: "   " } });

    expect(field.getAttribute("aria-invalid")).toBe("true");
    const save = screen.getByRole("button", { name: /^Save changes/ });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.submit(save);
    expect(updateLabel).not.toHaveBeenCalled();
  });

  it("shows a member the label without a way to change it", () => {
    renderSettings({ ...WALLET, canManageCustody: false });

    expect(screen.queryByLabelText("Wallet label")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save changes/ })).toBeNull();
    expect(screen.getAllByText("Treasury")).not.toHaveLength(0);
  });

  // The hint listed Issuance on stable, where no Issuance page exists to show the label.
  it("names Issuance where the label shows only where Issuance runs", () => {
    renderSettings(WALLET, "stable");
    expect(screen.queryByText(/Issuance/)).toBeNull();
    cleanup();

    renderSettings(WALLET, "experimental");
    expect(screen.getByText(/Issuance/)).not.toBeNull();
  });
});
