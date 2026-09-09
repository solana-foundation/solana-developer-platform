// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  completeQuickStartStep,
  quickStartKey,
  readQuickStart,
  setQuickStart,
} from "@/lib/dashboard-quick-start";
import { DashboardQuickStart } from "./dashboard-quick-start";

const workspace = vi.hoisted(() => ({
  initialQuickStartStep: "api-key" as "api-key" | "wallet" | "done" | null,
  pathname: "/dashboard",
  dashboardCacheScope: { userId: "user_test", orgId: "org_test" },
  selectedProjectId: "project_test",
  dashboardAccess: { capabilities: { canManageApiKeys: true, canManageCustody: true } },
  flags: { custody: true },
  sdpEnvironment: "sandbox",
}));
vi.mock("next/navigation", () => ({ usePathname: () => workspace.pathname }));
vi.mock("@/lib/quick-start-actions", () => ({
  saveQuickStartProgress: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
}));

const key = () => quickStartKey(workspace.dashboardCacheScope, workspace.selectedProjectId);
const ui = (docked = false) => (
  <I18nProvider locale="en" messages={getMessages("en")}>
    <DashboardQuickStart docked={docked} />
  </I18nProvider>
);

const renderGuide = () => {
  const view = render(ui());
  const launcher = view.queryByRole("button", { name: /Quick start \d\/3/ });
  if (launcher) fireEvent.click(launcher);
  return view;
};
let projectSequence = 0;

beforeEach(() => {
  workspace.initialQuickStartStep = "api-key";
  workspace.pathname = "/dashboard";
  workspace.selectedProjectId = `project_${++projectSequence}`;
  workspace.sdpEnvironment = "sandbox";
  workspace.flags.custody = true;
  workspace.dashboardAccess.capabilities.canManageApiKeys = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard quick start", () => {
  it("opens as a modal and can be minimized left without losing progress", () => {
    const view = render(ui());
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Create an API key" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Do this later" }));
    expect(view.queryByRole("heading")).toBeNull();
    expect(view.getByRole("complementary").className).toContain("left-4");
    expect(readQuickStart(key())).toBe("api-key");
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("links to API-key creation without prematurely completing the step", () => {
    const view = renderGuide();
    expect(view.getByRole("link", { name: "Create an API key" }).getAttribute("href")).toBe(
      "/dashboard/api-keys/new"
    );
    expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(readQuickStart(key())).toBe("api-key");
    act(() => completeQuickStartStep(key(), "api-key"));
    expect(view.getByText("Step 2 of 3 · Optional")).toBeTruthy();
    expect(view.getByRole("link", { name: "Create a wallet" }).getAttribute("href")).toBe(
      "/dashboard/wallets/setup"
    );
    act(() => completeQuickStartStep(key(), "wallet"));
    const faucet = view.getByRole("link", { name: "Open USDC faucet" });
    expect(faucet.getAttribute("href")).toBe("https://faucet.circle.com/");
    expect(faucet.getAttribute("target")).toBe("_blank");
    expect(readQuickStart(key())).toBe("faucet");
    fireEvent.click(view.getByRole("button", { name: "Finish quick start" }));
    expect(view.queryByRole("complementary")).toBeNull();
  });

  it("lets an existing API-key holder skip the optional wallet", () => {
    const view = renderGuide();
    fireEvent.click(view.getByRole("button", { name: "I already have an API key" }));
    fireEvent.click(view.getByRole("button", { name: "Skip this step" }));
    expect(view.getByRole("heading", { name: "Get test USDC" })).toBeTruthy();
    expect(view.getByText(/Test funds have no monetary value/)).toBeTruthy();
  });

  it("remembers dismissal and does not reopen after unrelated creation", () => {
    const view = render(ui());
    fireEvent.click(view.getByRole("button", { name: "Skip quick start" }));
    expect(window.localStorage.getItem(key())).toBe("done");
    act(() => completeQuickStartStep(key(), "api-key"));
    expect(readQuickStart(key())).toBe("done");
    view.unmount();
    expect(render(ui()).queryByRole("complementary")).toBeNull();
  });

  it("isolates progress when the project changes", () => {
    setQuickStart(key(), "done");
    const view = render(ui());
    expect(view.queryByRole("complementary")).toBeNull();
    workspace.selectedProjectId = "another_project";
    view.rerender(ui());
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(
      quickStartKey({ userId: "another_user", orgId: "org_test" }, workspace.selectedProjectId)
    ).not.toBe(key());
  });

  it("hides in production and for users who cannot create API keys", () => {
    workspace.sdpEnvironment = "production";
    const view = render(ui());
    expect(view.queryByRole("complementary")).toBeNull();
    workspace.sdpEnvironment = "sandbox";
    workspace.dashboardAccess.capabilities.canManageApiKeys = false;
    view.rerender(ui());
    expect(view.queryByRole("complementary")).toBeNull();
  });

  it("does not show the wizard for completed or unknown server setup", () => {
    workspace.initialQuickStartStep = "done";
    const view = render(ui());
    expect(view.queryByRole("dialog")).toBeNull();
    workspace.initialQuickStartStep = null;
    view.rerender(ui());
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("follows the action on the right after navigation, without advancing on click", () => {
    const view = renderGuide();
    fireEvent.click(view.getByRole("link", { name: "Create an API key" }));
    workspace.pathname = "/dashboard/api-keys/new";
    view.rerender(ui());
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("complementary").className).toContain("right-4");
    expect(readQuickStart(key())).toBe("api-key");
    fireEvent.click(view.getByRole("button", { name: "Minimize quick start" }));
    expect(view.queryByRole("heading")).toBeNull();
    view.unmount();
    expect(render(ui()).getByRole("complementary").className).toContain("right-4");
  });

  it("reserves space on form pages and returns focus without restarting the form", async () => {
    workspace.pathname = "/dashboard/api-keys/new";
    const view = render(ui(true));
    const dock = view.getByRole("complementary");
    expect(dock.hasAttribute("data-quick-start-docked")).toBe(true);
    expect(dock.className).not.toContain("fixed");
    expect(dock.className).toContain("shrink-0");
    expect(view.queryByRole("dialog")).toBeNull();
    const launcher = view.getByRole("button", { name: /Quick start 1\/3/ });
    fireEvent.click(launcher);
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.queryByRole("link", { name: "Create an API key" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Back to form" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("complementary").className).not.toContain("fixed");
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("keeps the optional step skippable when custody is unavailable", () => {
    workspace.flags.custody = false;
    setQuickStart(key(), "wallet");
    const view = renderGuide();
    expect(view.queryByRole("link", { name: "Create a wallet" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Skip this step" }));
    expect(view.getByRole("link", { name: "Open USDC faucet" })).toBeTruthy();
  });

  it("works when browser storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    const view = renderGuide();
    fireEvent.click(view.getByRole("button", { name: "I already have an API key" }));
    expect(view.getByRole("heading", { name: "Create a wallet" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Skip quick start" }));
    expect(view.queryByRole("complementary")).toBeNull();
  });

  it("picks up dismissal from another browser tab", () => {
    setQuickStart(key(), "wallet");
    const view = render(ui());
    act(() => {
      window.localStorage.setItem(key(), "done");
      window.dispatchEvent(new StorageEvent("storage", { key: key(), newValue: "done" }));
    });
    expect(view.queryByRole("complementary")).toBeNull();
  });
});
