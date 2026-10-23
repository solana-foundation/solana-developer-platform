// @vitest-environment jsdom

import type { CounterpartyAccount } from "@sdp/types/counterparties";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnchainSendWizard as useLegacyWizard } from "@/app/dashboard/[projectId]/payments/ramps/hooks/use-onchain-send-wizard";
import { useOnchainSendWizard as useRedesignWizard } from "@/app/dashboard/[projectId]/payments/ramps/hooks/use-onchain-send-wizard.redesign";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { OnchainSendStepContent as LegacyContent } from "./onchain-send-step-content";
import { OnchainSendStepContent as RedesignContent } from "./onchain-send-step-content.redesign";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const account: CounterpartyAccount = {
  id: "account_test",
  organizationId: "org_test",
  projectId: "prj_test_sandbox",
  counterpartyId: "cpty_test",
  accountKind: "crypto_wallet",
  label: "Destination",
  details: { address: "11111111111111111111111111111111" },
  providerAccountData: {},
  status: "active",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};
const managedWallet: PaymentsDashboardWallet = {
  id: "wallet_managed",
  walletId: "provider_managed",
  publicKey: "11111111111111111111111111111111",
  label: "Managed",
  provider: "fireblocks",
  custodyConfigId: "cc_test",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "SOL", mint: SOL_MINT, amount: "1000000000", uiAmount: "1", decimals: 9 }],
};
const wallets: PaymentsDashboardWallet[] = [
  managedWallet,
  {
    ...managedWallet,
    id: "wallet_byok",
    custodyConfigId: undefined,
    custodyConnectionId: "cconn_fireblocks",
  },
  {
    ...managedWallet,
    id: "wallet_privy",
    provider: "privy",
    custodyConfigId: undefined,
    custodyConnectionId: "cconn_privy",
  },
];
const fetchMock = vi.fn<typeof fetch>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: false,
          compliance: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          privateChannels: false,
          releaseChannel: "experimental",
          ramps: true,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
      >
        <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/dashboard/wallets?view=summary&includeBalances=true")
      return Response.json({ data: { wallets } });
    if (url === "/api/dashboard/counterparty/cpty_test/accounts?pageSize=100")
      return Response.json({ data: { accounts: [account] } });
    if (url.startsWith("/api/dashboard/fireblocks/destination?"))
      return Response.json({ data: { state: "approved", assetId: "SOL_TEST" } });
    if (url.startsWith("/api/dashboard/fireblocks/policy?"))
      return Response.json({ data: { state: "missing" } });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "legacy", useWizard: useLegacyWizard, Content: LegacyContent },
  { name: "redesign", useWizard: useRedesignWizard, Content: RedesignContent },
])("$name Fireblocks payment selection", ({ useWizard, Content }) => {
  it("limits native transfer checks and instructions to connected Fireblocks BYOK wallets", async () => {
    const { result } = renderHook(
      () =>
        useWizard({
          wallets,
          walletsError: null,
          issuedTokenSymbolsByMint: {},
          counterpartyId: account.counterpartyId,
          onExit: vi.fn(),
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.accountsLoading).toBe(false));
    act(() => {
      result.current.setField("accountId", account.id);
      result.current.setField("amount", "0.01");
    });
    const view = render(
      <Content
        wizard={{ ...result.current, currentStepId: "DETAILS" }}
        counterpartyName="Destination"
      />,
      { wrapper }
    );
    vi.useFakeTimers();
    for (const walletId of ["wallet_managed", "wallet_byok", "wallet_managed", "wallet_privy"]) {
      fetchMock.mockClear();
      act(() => result.current.selectWallet(walletId));
      view.rerender(
        <Content
          wizard={{ ...result.current, currentStepId: "DETAILS" }}
          counterpartyName="Destination"
        />
      );
      await act(() => vi.advanceTimersByTimeAsync(600));
      const checks = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost").pathname)
        .filter((path) => path.startsWith("/api/dashboard/fireblocks/"));
      expect(checks.sort()).toEqual(
        walletId === "wallet_byok" ? ["/api/dashboard/fireblocks/destination"] : []
      );
      expect(screen.queryByRole("link", { name: "Open Fireblocks" }) !== null).toBe(
        walletId === "wallet_byok"
      );
      view.rerender(
        <Content
          wizard={{ ...result.current, currentStepId: "REVIEW" }}
          counterpartyName="Destination"
        />
      );
      expect(screen.queryByText(/Your source vault pays the network fee in SOL/) !== null).toBe(
        walletId === "wallet_byok"
      );
    }
  });
});
