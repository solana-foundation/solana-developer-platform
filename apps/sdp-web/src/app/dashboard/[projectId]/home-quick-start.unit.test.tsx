// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  dismissQuickStart,
  quickStartKey,
  resumeQuickStart,
  setQuickStart,
} from "@/lib/dashboard-quick-start";
import DashboardLoading from "./(home)/loading";
import { HomeWorkspace } from "./home-workspace";

const workspace = vi.hoisted(() => ({
  initialQuickStartStep: "api-key",
  dashboardCacheScope: { userId: "home_user", orgId: "home_org" },
  selectedProjectId: "home_project",
  dashboardAccess: { capabilities: { canManageApiKeys: true, canManageCustody: true } },
  flags: { custody: true, issuance: true },
  sdpEnvironment: "sandbox",
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
  useOptionalDashboardWorkspace: () => workspace,
}));
const swr = vi.hoisted(() => ({
  activity: { activityRows: [] } as Record<string, unknown>,
  volume: { todaysVolume: 0, todaysVolumeError: null } as Record<string, unknown> | undefined,
}));
vi.mock("@/lib/dashboard-swr", () => ({
  usePersistedDashboardSWR: (key: string) => ({
    data: key === "dashboard-home-volume" ? swr.volume : swr.activity,
  }),
}));
vi.mock("./wallets/section-entry", () => ({
  SectionEntry: ({ children }: { children: ReactNode }) => children,
}));

let progressKey: string;
let orgSequence = 0;
beforeEach(() => {
  workspace.initialQuickStartStep = "api-key";
  workspace.dashboardCacheScope.orgId = `home_org_${++orgSequence}`;
  progressKey = quickStartKey(workspace.dashboardCacheScope);
});
function ui(totalBalanceError: string | null = null) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <HomeWorkspace
        totalBalance={null}
        totalBalanceError={totalBalanceError}
        wallets={[]}
        balances={[]}
        walletCount={0}
        issuedTokens={[]}
      />
    </I18nProvider>
  );
}
afterEach(() => {
  cleanup();
  workspace.sdpEnvironment = "sandbox";
  swr.activity = { activityRows: [] };
  swr.volume = { todaysVolume: 0, todaysVolumeError: null };
});

describe("home after quick start", () => {
  it("keeps loading and settled Home compact until quick start is dismissed", () => {
    const view = render(
      <>
        <DashboardLoading />
        {ui()}
      </>
    );
    expect(view.container.querySelector("[data-loading-home-hero]")).toBeNull();
    expect(view.container.querySelector("[data-loading-home-activity-row]")).toBeNull();
    expect(view.queryByText("Total Balance")).toBeNull();
    act(() => dismissQuickStart(progressKey));
    expect(view.container.querySelector("[data-loading-home-hero]")).toBeTruthy();
    expect(view.getByText("Total Balance")).toBeTruthy();
  });

  it("keeps the full loading layout for established organizations", () => {
    workspace.initialQuickStartStep = "wallet";
    const view = render(<DashboardLoading />);
    expect(view.container.querySelector("[data-loading-home-hero]")).toBeTruthy();
    expect(view.container.querySelector("[data-loading-home-activity-row]")).toBeTruthy();
  });

  it("preserves balances for an organization with existing API keys on a fresh browser", () => {
    workspace.initialQuickStartStep = "wallet";
    const view = render(ui());
    expect(view.getByText("Total Balance")).toBeTruthy();
    expect(view.getByRole("link", { name: "Create a wallet" })).toBeTruthy();
  });

  it("shows balances while the guide is dismissed and restores onboarding when resumed", () => {
    setQuickStart(progressKey, "wallet");
    const view = render(ui());
    expect(view.queryByText("Total Balance")).toBeNull();
    act(() => dismissQuickStart(progressKey));
    expect(view.getByText("Total Balance")).toBeTruthy();
    act(() => resumeQuickStart(progressKey));
    expect(view.queryByText("Total Balance")).toBeNull();
  });

  it("keeps the balance and first-wallet surface in production without the sandbox guide", () => {
    workspace.sdpEnvironment = "production";
    setQuickStart(progressKey, "api-key");
    const view = render(ui());
    expect(view.getByText("Total Balance")).toBeTruthy();
    expect(view.getByRole("link", { name: "Create a wallet" })).toBeTruthy();
  });

  it("shows balances immediately on completion with a first-wallet action and no tutorials", () => {
    setQuickStart(progressKey, "api-key");
    const view = render(ui());
    expect(view.queryByText("Total Balance")).toBeNull();
    expect(view.queryByRole("heading", { name: "Tutorials" })).toBeNull();
    act(() => setQuickStart(progressKey, "done"));
    expect(view.getByText("Total Balance")).toBeTruthy();
    expect(view.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(view.getByRole("link", { name: "Create a wallet" }).getAttribute("href")).toBe(
      "/dashboard/wallets/setup"
    );
    expect(view.getByText("Create your first wallet to start tracking balances.")).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Tutorials" })).toBeNull();
    view.unmount();
    expect(render(ui()).getByText("Total Balance")).toBeTruthy();
  });

  it("does not turn unavailable balances into a false zero after completion", () => {
    setQuickStart(progressKey, "done");
    const view = render(ui("Balance data is unavailable right now."));
    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.getByText("Balance data is unavailable right now.")).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Tutorials" })).toBeNull();
  });

  it("says why today's volume is missing on the page, not only on hover", () => {
    setQuickStart(progressKey, "done");
    swr.volume = {
      todaysVolume: null,
      todaysVolumeError: "Payments activity is unavailable right now.",
    };
    const view = render(ui());
    const reason = view.getByText("Payments activity is unavailable right now.");
    expect(reason.tagName).toBe("DD");
    expect(view.container.querySelector("dd[title]")).toBeNull();
  });
  // Volume waits on every wallet, so it can land after the page: until then it
  // is unknown, which is a dash, never a measured $0.00.
  it("shows a dash, not $0.00, while today's volume is still loading", () => {
    setQuickStart(progressKey, "done");
    swr.volume = undefined;
    const view = render(ui());
    const label = view.getByText("Today's Volume");
    expect(label.nextElementSibling?.textContent).toBe("—");
  });
});
