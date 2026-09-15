// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { useOnchainReceiveWizard } from "./use-onchain-receive-wizard";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const wallets: PaymentsDashboardWallet[] = [
  {
    id: "wallet-live",
    walletId: "provider-live",
    publicKey: "live-wallet-address",
    label: "Treasury",
    balances: [],
  },
];

const fetchMock = vi.fn<typeof fetch>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
        projects={[]}
        initialSelectedProjectId={null}
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation((input) => {
    if (String(input) === "/api/dashboard/wallets?view=summary&includeBalances=true") {
      return Promise.resolve(Response.json({ data: { wallets } }));
    }
    return Promise.resolve(Response.json({ data: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useOnchainReceiveWizard", () => {
  it("requires a live wallet and completes the receive flow", async () => {
    const onExit = vi.fn();
    const { result } = renderHook(
      () =>
        useOnchainReceiveWizard({
          wallets,
          walletsError: null,
          counterpartyId: "counterparty-test",
          onExit,
        }),
      { wrapper }
    );

    expect(result.current.canProceed).toBe(false);
    act(() => result.current.setWalletId("wallet-stale"));
    expect(result.current.canProceed).toBe(false);

    act(() => result.current.handleSecondary());
    expect(onExit).toHaveBeenCalledOnce();

    act(() => result.current.setWalletId("wallet-live"));
    expect(result.current.canProceed).toBe(true);
    act(() => result.current.handlePrimary());
    expect(result.current.currentStepId).toBe("RECEIVE");
    expect(result.current.summaryDetails).toHaveLength(1);
    expect(result.current.summaryDetails[0]?.value).toBe("Treasury");

    act(() => result.current.handlePrimary());
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/payments");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
