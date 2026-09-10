// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { quickStartKey, setQuickStart } from "@/lib/dashboard-quick-start";
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
}));
vi.mock("@/lib/dashboard-swr", () => ({
  usePersistedDashboardSWR: () => ({ data: { activityRows: [], todaysVolume: 0 } }),
}));
vi.mock("./wallets/section-entry", () => ({
  SectionEntry: ({ children }: { children: ReactNode }) => children,
}));

let progressKey: string;
let orgSequence = 0;
beforeEach(() => {
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
});

describe("home after quick start", () => {
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
});
