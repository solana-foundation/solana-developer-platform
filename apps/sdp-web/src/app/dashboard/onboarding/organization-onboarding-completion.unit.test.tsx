// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { completeOrganizationOnboardingAction } from "./actions";
import { OrganizationOnboardingFlow } from "./organization-onboarding-flow";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("./actions", () => ({
  completeOrganizationOnboardingAction: vi.fn(),
  saveOnboardingRpcAction: vi.fn(),
}));

const WALLET_ADDRESS = "AMX5b8RwtSyZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";

function renderCustodyStep() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OrganizationOnboardingFlow
        organizationId="org_test"
        currentStep="custody"
        initialRpcProvider="helius"
        rpcProviders={["helius"]}
        custodyProviders={["privy"]}
      />
    </I18nProvider>
  );
}

async function finishSetup() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Privy/ }));
  await user.click(screen.getByRole("button", { name: /Finish setup/ }));
}

describe("onboarding completion", () => {
  beforeEach(() => {
    cleanup();
    push.mockClear();
    refresh.mockClear();
    vi.mocked(completeOrganizationOnboardingAction).mockReset();
  });

  it("shows the wallet setup created instead of leaving silently", async () => {
    vi.mocked(completeOrganizationOnboardingAction).mockResolvedValue({
      status: "success",
      wallet: { publicKey: WALLET_ADDRESS, walletId: "wal_1" },
    });

    renderCustodyStep();
    await finishSetup();

    await waitFor(() => {
      expect(screen.getByText("Your workspace is ready")).toBeTruthy();
    });
    expect(screen.getByText(WALLET_ADDRESS)).toBeTruthy();
    expect(screen.getByText(/Privy is connected/)).toBeTruthy();
    // The redirect is now a choice the user makes, not something done to them.
    expect(push).not.toHaveBeenCalled();
    // A refresh here re-runs the server page, which redirects on completion
    // and would unmount this panel.
    expect(refresh).not.toHaveBeenCalled();
    // Exits are full navigations so the shell's setup guard sees fresh state.
    const exits = screen.getAllByRole("link");
    expect(exits.map((el) => el.getAttribute("href"))).toEqual([
      "/dashboard",
      "/dashboard/wallets",
    ]);
  });

  it("still shows the wallet when an earlier attempt had provisioned it", async () => {
    // Every recovery path in initializeCustodyWallet resolves the wallet it
    // finds or repairs, so completion always has an address to show.
    vi.mocked(completeOrganizationOnboardingAction).mockResolvedValue({
      status: "success",
      wallet: { publicKey: WALLET_ADDRESS, walletId: "wallet-1" },
    });

    renderCustodyStep();
    await finishSetup();

    await waitFor(() => {
      expect(screen.getByText("Your workspace is ready")).toBeTruthy();
    });
    expect(screen.getByText(WALLET_ADDRESS)).toBeTruthy();
  });

  it("keeps the user in the wizard when setup fails", async () => {
    vi.mocked(completeOrganizationOnboardingAction).mockResolvedValue({
      status: "error",
      message: "Setup failed",
    });

    renderCustodyStep();
    await finishSetup();

    await waitFor(() => {
      expect(screen.getByText("Setup failed")).toBeTruthy();
    });
    expect(screen.queryByText("Your workspace is ready")).toBeNull();
  });
});
