// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { useQuickStart } from "./use-quick-start";

type QuickStartState = ReturnType<typeof useQuickStart>;

const NOW = new Date("2026-09-25T12:00:00.000Z").getTime();
const KEY = "sdp:quick-start:v2:user:org";
const mocks = vi.hoisted(() => ({
  state: null as unknown as QuickStartState,
  push: vi.fn(),
  environment: "sandbox",
}));

vi.mock("./use-quick-start", () => ({ useQuickStart: () => mocks.state }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

const { DashboardQuickStart } = await import("./dashboard-quick-start");
const { readQuickStartPrefs } = await import("@/lib/dashboard-quick-start");

function state(overrides: Partial<QuickStartState> = {}): QuickStartState {
  return {
    storageKey: KEY,
    eligible: true,
    visible: true,
    complete: false,
    prefs: {
      dismissed: false,
      collapsed: false,
      sidebarCollapsed: false,
      skipped: { custody: new Date(NOW - 3_600_000).toISOString() },
    },
    status: { rpcProvider: null, custodyProvider: null, apiKeyCount: 0, lastCallAt: null },
    probe: {
      outcome: "ok",
      status: 200,
      provider: "default",
      checkedAt: new Date(NOW - 40_000).toISOString(),
    },
    steps: [
      { id: "rpc", state: "done" },
      { id: "custody", state: "skipped" },
      { id: "first-call", state: "pending" },
    ],
    ...overrides,
  };
}

function renderQuickStart(variant: "overview" | "sidebar" | "settings", collapsed = false) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardQuickStart variant={variant} collapsed={collapsed} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  mocks.state = state();
  mocks.environment = "sandbox";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Overview quick start", () => {
  it("reads the prototype's three steps with their next actions", () => {
    renderQuickStart("overview");
    const card = screen.getByRole("region", { name: "Quick start" });
    expect(within(card).getByText("2 of 3")).toBeTruthy();
    expect(
      within(card).getByText("Managed RPC, devnet. A probe answered 40 seconds ago.")
    ).toBeTruthy();
    expect(within(card).getByText("Proven · probe 200 · 40s ago")).toBeTruthy();
    expect(
      within(card).getByText("Skipped today. Nothing holds funds until a provider is connected.")
    ).toBeTruthy();
    expect(within(card).getByText("Skipped · today")).toBeTruthy();
    expect(within(card).getByText("Needs a key")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Use your own provider" }).getAttribute("href")
    ).toBe("/dashboard/integrations?tab=rpc");
    expect(within(card).getByRole("link", { name: "Connect" }).getAttribute("href")).toBe(
      "/dashboard/integrations?tab=custody"
    );
    expect(within(card).getByRole("link", { name: "Create an API key" }).getAttribute("href")).toBe(
      "/dashboard/api-keys/new"
    );
  });

  it("offers a skip while custody is still open, and remembers it", () => {
    mocks.state = state({
      prefs: { ...state().prefs, skipped: {} },
      steps: [
        { id: "rpc", state: "done" },
        { id: "custody", state: "pending" },
        { id: "first-call", state: "pending" },
      ],
    });
    renderQuickStart("overview");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(readQuickStartPrefs(KEY).skipped.custody).toBe(new Date(NOW).toISOString());
  });

  it("waits for a call once a key exists, and names the provider the organization saved", () => {
    mocks.state = state({
      status: { rpcProvider: "helius", custodyProvider: null, apiKeyCount: 2, lastCallAt: null },
    });
    renderQuickStart("overview");
    expect(screen.getByText("Helius, devnet. A probe answered 40 seconds ago.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change provider" })).toBeTruthy();
    expect(screen.getByText("Waiting for a call")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View API keys" })).toBeTruthy();
  });

  it("folds to its header and dismisses", () => {
    renderQuickStart("overview");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(readQuickStartPrefs(KEY).collapsed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(readQuickStartPrefs(KEY).dismissed).toBe(true);
  });

  it("renders nothing once the guide is not visible", () => {
    mocks.state = state({ visible: false });
    const { container } = renderQuickStart("overview");
    expect(container.innerHTML).toBe("");
  });
});

describe("Sidebar quick start", () => {
  it("links each step to where it is done", () => {
    renderQuickStart("sidebar");
    const card = screen.getByRole("complementary", { name: "Setup" });
    expect(
      within(card)
        .getByRole("link", { name: /Solana requests are answering/ })
        .getAttribute("href")
    ).toBe("/dashboard/integrations?tab=rpc");
    expect(within(card).getByRole("link", { name: /Connect custody, skipped/ })).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: /Your first call has arrived/ })
        .getAttribute("href")
    ).toBe("/dashboard/api-keys/new");
    fireEvent.click(within(card).getByRole("button", { name: "Hide" }));
    expect(readQuickStartPrefs(KEY).sidebarCollapsed).toBe(true);
  });

  it("shrinks to one link on the icon rail", () => {
    renderQuickStart("sidebar", true);
    expect(screen.getByRole("link", { name: "Setup · 2 of 3" }).getAttribute("href")).toBe(
      "/dashboard"
    );
  });
});

describe("Settings quick start", () => {
  it("brings a dismissed guide back and opens the Overview", () => {
    mocks.state = state({ prefs: { ...state().prefs, dismissed: true } });
    renderQuickStart("settings");
    expect(screen.getByText("2 of 3 steps done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show quick start" }));
    expect(readQuickStartPrefs(KEY).dismissed).toBe(false);
    expect(mocks.push).toHaveBeenCalledWith("/dashboard");
  });

  it("explains why the guide is unavailable outside Sandbox", () => {
    mocks.environment = "production";
    mocks.state = state({ eligible: false, visible: false });
    renderQuickStart("settings");
    expect(screen.getByText("Switch to Sandbox to use the quick start.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
