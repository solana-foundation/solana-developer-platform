// @vitest-environment jsdom

import type { SdpModule } from "@sdp/types/release-channels";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import {
  failedHomeRead,
  HOME_READ_URLS,
  issuedTokensResponse,
  stubHomeReads,
  walletAggregateResponse,
  walletSummariesResponse,
} from "@/test/home-reads";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import DashboardPage from "./(home)/page";

const { authMock, custodyMock, issuanceMock, workspace } = vi.hoisted(() => ({
  authMock: vi.fn(),
  custodyMock: vi.fn(),
  issuanceMock: vi.fn(),
  workspace: {
    sdpEnvironment: "production",
    dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
    selectedProjectId: "prj_test_sandbox",
    initialQuickStartStatus: null,
    flags: { custody: true, issuance: true, payments: true },
    dashboardAccess: {
      capabilities: {
        canWrite: true,
        canManageCustody: true,
        canManageTokenWrite: true,
        canManageApiKeys: true,
      },
    },
  },
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: authMock }));
vi.mock("@/flags", () => ({ issuance: issuanceMock }));
vi.mock("@/flags/release-channel", () => ({
  isModuleInDeploymentReleaseChannel: (module: SdpModule) => module !== "custody" || custodyMock(),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
  useOptionalDashboardWorkspace: () => workspace,
  useCanWrite: () => workspace.dashboardAccess.capabilities.canWrite,
}));
vi.mock("./home-workspace.data", () => ({ useHomeActivitySnapshot: () => ({}) }));
vi.mock("./overview-network.data", () => ({ useOverviewNetwork: () => ({ status: "loading" }) }));

async function renderPage() {
  const page = await DashboardPage();
  if (page === null) throw new Error("Expected the home workspace");
  return render(
    <EnglishI18n>
      <DashboardReadsProvider>{page}</DashboardReadsProvider>
    </EnglishI18n>
  );
}

function sandboxRead(path: string) {
  return { path, projectId: SANDBOX_PROJECT.id, demo: null };
}

beforeEach(() => {
  resetDashboardNavigation();
  authMock.mockResolvedValue({ orgId: "org_test" });
  issuanceMock.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard home module flags", () => {
  it("renders the first-run prompt with no reads when the release channel leaves Custody out", async () => {
    custodyMock.mockReturnValue(false);
    const fetchMock = stubDashboardFetch(failedHomeRead);

    await renderPage();
    await act(() => Promise.resolve());

    expect(screen.getByRole("heading", { name: "Start with a wallet" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws the hero skeleton while the account reads load, then the balance", async () => {
    custodyMock.mockReturnValue(true);
    const fetchMock = stubHomeReads({
      aggregate: () =>
        walletAggregateResponse(1, [
          {
            token: "USDC",
            mint: "mint_test_usdc",
            amount: "5000000",
            uiAmount: "5",
            decimals: 6,
            usdValue: 5,
          },
        ]),
      wallets: () => walletSummariesResponse(["wal_test_1"]),
      issuedTokens: () => issuedTokensResponse([]),
    });

    await renderPage();

    expect(document.querySelector("[data-loading-home-hero]")).not.toBeNull();
    await screen.findAllByText("$5.00");
    expect(document.querySelector("[data-loading-home-hero]")).toBeNull();
    expect(sentDashboardReads(fetchMock)).toEqual([
      sandboxRead(HOME_READ_URLS.aggregate),
      sandboxRead(HOME_READ_URLS.wallets),
      sandboxRead(HOME_READ_URLS.issuedTokens),
    ]);
  });
});
