// @vitest-environment jsdom

/**
 * @title Regression: a rendered project's wallet inventory may not be replaced
 * through the shared project cookie
 * @notice Security behavior under test (Apex SOLA9-618): a payments workspace
 * rendered for project A keeps consuming project A's wallet inventory and
 * balances, even after a sibling tab moves the shared
 * `sdp_selected_project_id` cookie to accessible project B and the wallet SWR
 * entry revalidates. The wallet request must be bound to the mounted
 * workspace's project end to end: the SWR key carries the rendered project id,
 * the wallet BFF receives it, validates it against the authenticated
 * organization, and pins `x-project-id` to it instead of trusting the mutable
 * cookie.
 *
 * The API membership check always holds; the defect is project-context
 * replacement inside a still-mounted workspace, so the secure assertion is
 * that B's wallets never enter A's cache or provider at all.
 */

import type { PaymentsDashboardWallet, Project } from "@sdp/types";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getWallets } from "@/app/api/dashboard/wallets/route";
import { useWalletInventoryRefresh } from "@/app/dashboard/custody/use-wallet-inventory-refresh";
import { usePaymentsActionWallets } from "@/app/dashboard/payments/ramps/hooks/use-payments-action-wallets";
import {
  DashboardWorkspaceProvider,
  useDashboardWorkspace,
} from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { selectProjectAction } from "@/lib/project-cookie-action";

const state = vi.hoisted(() => ({
  cookieProject: "project-a",
  upstreamWalletProjects: [] as string[],
  auth: {
    isLoaded: true,
    userId: "user-a",
    orgId: "org-a",
  },
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => state.auth,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/dashboard-url-state", () => ({
  readDashboardTabFromUrl: () => null,
  useDashboardUrlState: () => ({
    replaceSearchParams: vi.fn(),
    searchParams: new URLSearchParams(),
  }),
}));

const projects = [
  { id: "project-a", slug: "default-sandbox" },
  { id: "project-b", slug: "project-b" },
] as Project[];

const walletA: PaymentsDashboardWallet = {
  id: "cwlt-project-a",
  walletId: "provider-wallet-a",
  publicKey: "11111111111111111111111111111111",
  label: "Project A Treasury",
  custodyConfigId: "config-a",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: "mint-a", amount: "10", uiAmount: "10", decimals: 6 }],
};

const walletB: PaymentsDashboardWallet = {
  id: "cwlt-project-b",
  walletId: "provider-wallet-b",
  publicKey: "22222222222222222222222222222222",
  label: "Project B Treasury",
  custodyConfigId: "config-b",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: "mint-b", amount: "200", uiAmount: "200", decimals: 6 }],
};

const walletByProject = { "project-a": [walletA], "project-b": [walletB] } as const;

const cookieStore = {
  get(name: string) {
    if (name === "sdp_selected_project_id") return { value: state.cookieProject };
    if (name === "sdp_workspace_scope") {
      return { value: `user-a:org-a:${state.cookieProject}` };
    }
    return undefined;
  },
  set(name: string, value: string) {
    if (name === "sdp_selected_project_id") state.cookieProject = value;
  },
  delete(name: string) {
    if (name === "sdp_selected_project_id") state.cookieProject = "";
  },
};

function WalletProbe({ initialWallets }: { initialWallets: PaymentsDashboardWallet[] }) {
  const { selectedProjectId } = useDashboardWorkspace();
  const { liveWallets } = usePaymentsActionWallets(initialWallets, null);
  const refreshWalletInventory = useWalletInventoryRefresh();
  const wallet = liveWallets[0] ?? null;

  return (
    <section>
      <output data-testid="rendered-project">{selectedProjectId}</output>
      <output data-testid="wallet-label">{wallet?.label ?? "none"}</output>
      <output data-testid="wallet-balance">{wallet?.balances?.[0]?.uiAmount ?? "none"}</output>
      <button type="button" onClick={() => refreshWalletInventory()}>
        Revalidate wallet inventory
      </button>
    </section>
  );
}

function TestWorkspace({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
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
        serverDashboardCacheScope={{ orgId: "org-a", userId: "user-a" }}
        projects={projects}
        initialSelectedProjectId="project-a"
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

describe("rendered workspace keeps its own project's wallet inventory", () => {
  beforeEach(() => {
    state.cookieProject = "project-a";
    state.upstreamWalletProjects = [];
    mocks.auth.mockResolvedValue({
      userId: "user-a",
      orgId: "org-a",
      getToken: vi.fn().mockResolvedValue("clerk-session-for-user-a"),
    });
    mocks.cookies.mockResolvedValue(cookieStore);
    process.env.SDP_API_BASE_URL = "https://api.example.test";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ignores a sibling-tab cookie switch when revalidating the wallet inventory", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);

      if (url.startsWith("/api/dashboard/wallets")) {
        return getWallets(new Request(`https://dashboard.example.test${url}`));
      }

      const parsed = new URL(url);
      if (parsed.origin !== "https://api.example.test") {
        throw new Error(`Unexpected fetch target: ${url}`);
      }
      if (parsed.pathname === "/v1/projects") {
        return Response.json({ data: { projects } });
      }
      if (parsed.pathname !== "/v1/wallets") {
        throw new Error(`Unexpected upstream path: ${parsed.pathname}`);
      }

      const projectId = new Headers(init?.headers).get("x-project-id");
      if (projectId !== "project-a" && projectId !== "project-b") {
        return Response.json(
          { error: { message: "Requested project is not accessible" } },
          { status: 403 }
        );
      }
      state.upstreamWalletProjects.push(projectId);
      return Response.json({ data: { wallets: walletByProject[projectId] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TestWorkspace>
        <WalletProbe initialWallets={[walletA]} />
      </TestWorkspace>
    );

    await waitFor(() => expect(state.upstreamWalletProjects).toContain("project-a"));
    expect(screen.getByTestId("rendered-project").textContent).toBe("project-a");
    expect(screen.getByTestId("wallet-label").textContent).toBe(walletA.label);
    expect(screen.getByTestId("wallet-balance").textContent).toBe("10");

    // A sibling tab selects project B through the normal project selector's
    // server action, moving the shared browser cookie under this tab.
    await act(async () => {
      await selectProjectAction("project-b");
    });
    expect(state.cookieProject).toBe("project-b");

    // Negative control: the selector refuses a project outside the
    // authenticated user's listed membership and leaves B selected.
    await expect(selectProjectAction("project-not-listed")).rejects.toThrow(
      "Project is not available in this organization"
    );
    expect(state.cookieProject).toBe("project-b");

    // The still-mounted A workspace refreshes its wallet inventory while the
    // shared cookie already names B. The button discards the refresh promise,
    // so wait for the new upstream wallet read it triggers before asserting
    // which project that read was bound to; if the post-switch refresh never
    // runs, this wait times out instead of passing on the initial request.
    const upstreamReadsBeforeRefresh = state.upstreamWalletProjects.length;
    await act(async () => {
      screen.getByRole("button", { name: "Revalidate wallet inventory" }).click();
    });
    await waitFor(() =>
      expect(state.upstreamWalletProjects.length).toBeGreaterThan(upstreamReadsBeforeRefresh)
    );

    // Secure behavior: A keeps consuming A's wallet inventory and balances.
    expect(screen.getByTestId("rendered-project").textContent).toBe("project-a");
    expect(screen.getByTestId("wallet-label").textContent).toBe(walletA.label);
    expect(screen.getByTestId("wallet-balance").textContent).toBe("10");
    // Every upstream wallet read stayed bound to the rendered project; B's
    // wallets never entered this workspace's cache or provider.
    expect(state.upstreamWalletProjects).not.toContain("project-b");
    expect(state.upstreamWalletProjects[state.upstreamWalletProjects.length - 1]).toBe("project-a");
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input).startsWith("/api/dashboard/wallets?") &&
          String(input).includes("projectId=project-a")
      )
    ).toBe(true);
  });
});
