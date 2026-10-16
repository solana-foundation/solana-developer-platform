// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  type QuickStartPrefs,
  type QuickStartStatus,
  quickStartKey,
  readQuickStartPrefs,
} from "@/lib/dashboard-quick-start.redesign";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";

const NOW = new Date("2026-09-25T12:00:00.000Z").getTime();
const SCOPE = { userId: "user", orgId: "org" };
const KEY = quickStartKey(SCOPE);
const mocks = vi.hoisted(() => ({
  workspace: {
    sdpEnvironment: "sandbox",
    flags: { newDesign: true },
    dashboardAccess: { capabilities: { canManageApiKeys: true } },
    dashboardCacheScope: { userId: "user", orgId: "org" },
    selectedProjectId: "prj_test_sandbox",
    initialQuickStartStatus: null as unknown,
  },
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
// The viewer's workspace is one ambient input per render; everything else here is real.
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));

const { DashboardQuickStart } = await import("./dashboard-quick-start.redesign");

const SKIPPED_AN_HOUR_AGO = new Date(NOW - 3_600_000).toISOString();
const PENDING_STATUS: QuickStartStatus = {
  custodyProvider: null,
  apiKeyCount: 0,
  lastCallAt: null,
};

/** Sets what the server read and what the browser remembers, before the guide renders. */
function setup({
  status = PENDING_STATUS,
  prefs = { skipped: { custody: SKIPPED_AN_HOUR_AGO } },
}: {
  status?: QuickStartStatus;
  prefs?: Partial<QuickStartPrefs>;
} = {}) {
  mocks.workspace.initialQuickStartStatus = status;
  window.localStorage.setItem(KEY, JSON.stringify(prefs));
}

function renderQuickStart(variant: "overview" | "sidebar" | "settings", collapsed = false) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <DashboardQuickStart variant={variant} collapsed={collapsed} />
      </I18nProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  mocks.workspace.sdpEnvironment = "sandbox";
  // The status arrives with the page, so the guide reads nothing on mount.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Overview quick start", () => {
  it("reads the two steps with their next actions", () => {
    setup();
    renderQuickStart("overview");
    const card = screen.getByRole("region", { name: "Quick start" });
    expect(within(card).getByText("1 of 2")).toBeTruthy();
    expect(
      within(card).getByText("Skipped today. Nothing holds funds until a provider is connected.")
    ).toBeTruthy();
    expect(within(card).getByText("Skipped · today")).toBeTruthy();
    expect(within(card).getByText("Needs a key")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Connect" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/integrations?tab=custody"
    );
    expect(within(card).getByRole("link", { name: "Create an API key" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/api-keys/new"
    );
  });

  it("offers a skip while custody is still open, and remembers it", () => {
    setup({ prefs: {} });
    renderQuickStart("overview");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(readQuickStartPrefs(KEY).skipped.custody).toBe(new Date(NOW).toISOString());
  });

  it("waits for a call once a key exists", () => {
    setup({ status: { custodyProvider: null, apiKeyCount: 2, lastCallAt: null } });
    renderQuickStart("overview");
    expect(screen.getByText("Waiting for a call")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View API keys" })).toBeTruthy();
  });

  it("folds to its header and dismisses", () => {
    setup();
    renderQuickStart("overview");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(readQuickStartPrefs(KEY).collapsed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss quick start" }));
    expect(readQuickStartPrefs(KEY).dismissed).toBe(true);
  });

  it("renders nothing once the guide is not visible", () => {
    setup({
      status: { custodyProvider: "privy", apiKeyCount: 1, lastCallAt: "2026-09-25T10:00:00Z" },
    });
    const { container } = renderQuickStart("overview");
    expect(container.innerHTML).toBe("");
  });
});

describe("Sidebar quick start", () => {
  it("links each step to where it is done", () => {
    setup();
    renderQuickStart("sidebar");
    const card = screen.getByRole("complementary", { name: "Setup" });
    expect(within(card).getByRole("link", { name: /Connect custody, skipped/ })).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: /Your first call has arrived/ })
        .getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox/api-keys/new");
    fireEvent.click(within(card).getByRole("button", { name: "Hide" }));
    expect(readQuickStartPrefs(KEY).sidebarCollapsed).toBe(true);
  });

  it("shrinks to one link on the icon rail", () => {
    setup();
    renderQuickStart("sidebar", true);
    expect(screen.getByRole("link", { name: "Setup · 1 of 2" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox"
    );
  });
});

describe("Settings quick start", () => {
  it("brings a dismissed guide back and opens the Overview", () => {
    setup({ prefs: { skipped: { custody: SKIPPED_AN_HOUR_AGO }, dismissed: true } });
    renderQuickStart("settings");
    expect(screen.getByText("1 of 2 steps done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show quick start" }));
    expect(readQuickStartPrefs(KEY).dismissed).toBe(false);
    expect(dashboardRouter.push).toHaveBeenCalledWith("/dashboard/prj_test_sandbox");
  });

  it("says the guide is unavailable while the status is unknown, and offers no way in", () => {
    setup();
    mocks.workspace.initialQuickStartStatus = null;
    renderQuickStart("settings");
    expect(
      screen.getByText("Quick start is unavailable right now. Refresh the page to try again.")
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still brings a dismissed guide back when its status could not be read", () => {
    setup({ prefs: { dismissed: true } });
    mocks.workspace.initialQuickStartStatus = null;
    renderQuickStart("settings");
    fireEvent.click(screen.getByRole("button", { name: "Show quick start" }));
    expect(readQuickStartPrefs(KEY).dismissed).toBe(false);
  });

  it("explains why the guide is unavailable outside Sandbox", () => {
    mocks.workspace.sdpEnvironment = "production";
    setup();
    renderQuickStart("settings");
    expect(screen.getByText("Switch to Sandbox to use the quick start.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
