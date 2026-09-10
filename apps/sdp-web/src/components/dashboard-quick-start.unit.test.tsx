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
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
}));

const key = () => quickStartKey(workspace.dashboardCacheScope);
const ui = (collapsed = false) => (
  <I18nProvider locale="en" messages={getMessages("en")}>
    <DashboardQuickStart collapsed={collapsed} />
  </I18nProvider>
);

const renderGuide = () => {
  const view = render(ui());
  const launcher = view.queryByRole("button", { name: /SDP quick start · \d\/3/ });
  if (launcher) fireEvent.click(launcher);
  return view;
};
let orgSequence = 0;

beforeEach(() => {
  workspace.initialQuickStartStep = "api-key";
  workspace.pathname = "/dashboard";
  workspace.dashboardCacheScope = { userId: "user_test", orgId: `org_${++orgSequence}` };
  workspace.selectedProjectId = "project_test";
  workspace.sdpEnvironment = "sandbox";
  workspace.flags.custody = true;
  workspace.dashboardAccess.capabilities.canManageApiKeys = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard quick start", () => {
  it("starts as a sidebar card and opens the guide only when requested", async () => {
    const view = render(ui());
    expect(view.queryByRole("dialog")).toBeNull();
    const card = view.getByRole("complementary");
    expect(card.hasAttribute("data-quick-start-sidebar")).toBe(true);
    expect(card.className).not.toContain("fixed");
    const launcher = view.getByRole("button", { name: "SDP quick start · 1/3" });
    fireEvent.click(launcher);
    expect(view.getByRole("heading", { name: "Create your API key" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Continue later" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(readQuickStart(key())).toBe("api-key");
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("links to API-key creation without prematurely completing the step", () => {
    const view = renderGuide();
    expect(view.getByRole("link", { name: "Create API key" }).getAttribute("href")).toBe(
      "/dashboard/api-keys/new"
    );
    expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(readQuickStart(key())).toBe("api-key");
    act(() => completeQuickStartStep(key(), "api-key"));
    expect(view.getByText("Step 2 of 3 · Optional")).toBeTruthy();
    expect(view.getByRole("link", { name: "Create wallet" }).getAttribute("href")).toBe(
      "/dashboard/wallets/setup"
    );
    act(() => completeQuickStartStep(key(), "wallet"));
    expect(readQuickStart(key())).toBe("done");
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.queryByRole("complementary")).toBeNull();
  });

  it("lets an existing API-key holder skip the optional wallet", () => {
    const view = renderGuide();
    fireEvent.click(view.getByRole("button", { name: "I already have an API key" }));
    fireEvent.click(view.getByRole("button", { name: "Skip wallet setup" }));
    expect(view.getByRole("heading", { name: "Get test USDC" })).toBeTruthy();
    expect(view.getByText(/Test USDC has no monetary value/)).toBeTruthy();
    const faucet = view.getByRole("link", { name: "Open Circle faucet" });
    expect(faucet.getAttribute("href")).toBe("https://faucet.circle.com/");
    expect(faucet.getAttribute("target")).toBe("_blank");
    expect(readQuickStart(key())).toBe("faucet");
    fireEvent.click(view.getByRole("button", { name: "Finish quick start" }));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("remembers dismissal and does not reopen after unrelated creation", () => {
    const view = render(ui());
    fireEvent.click(view.getByRole("button", { name: "Dismiss SDP quick start" }));
    expect(window.localStorage.getItem(key())).toBe("done");
    act(() => completeQuickStartStep(key(), "api-key"));
    expect(readQuickStart(key())).toBe("done");
    view.unmount();
    expect(render(ui()).queryByRole("complementary")).toBeNull();
  });

  it("keeps dismissal across projects and isolates it between organizations and users", () => {
    setQuickStart(key(), "done");
    const view = render(ui());
    expect(view.queryByRole("complementary")).toBeNull();
    workspace.selectedProjectId = "another_project";
    view.rerender(ui());
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.queryByRole("complementary")).toBeNull();
    workspace.dashboardCacheScope.orgId = "another_org";
    view.rerender(ui());
    expect(view.getByRole("button", { name: "SDP quick start · 1/3" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Dismiss SDP quick start" }));
    workspace.dashboardCacheScope.userId = "another_user";
    view.rerender(ui());
    expect(view.getByRole("button", { name: "SDP quick start · 1/3" })).toBeTruthy();
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

  it("keeps the sidebar card after navigation without advancing on click", () => {
    const view = renderGuide();
    fireEvent.click(view.getByRole("link", { name: "Create API key" }));
    workspace.pathname = "/dashboard/api-keys/new";
    view.rerender(ui());
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("complementary").hasAttribute("data-quick-start-sidebar")).toBe(true);
    expect(readQuickStart(key())).toBe("api-key");
    view.unmount();
    const restored = render(ui());
    expect(restored.queryByRole("dialog")).toBeNull();
    expect(restored.getByRole("button", { name: "SDP quick start · 1/3" })).toBeTruthy();
  });

  it("returns focus to the sidebar without resetting an in-progress form", async () => {
    workspace.pathname = "/dashboard/api-keys/new";
    const view = render(
      <>
        <input aria-label="Key name" defaultValue="My integration" />
        {ui()}
      </>
    );
    const launcher = view.getByRole("button", { name: "SDP quick start · 1/3" });
    fireEvent.click(launcher);
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.queryByRole("link", { name: "Create API key" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Back to form" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("textbox", { name: "Key name" }).getAttribute("value")).toBe(
      "My integration"
    );
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it("keeps a compact launcher in the collapsed sidebar with dismissal in the guide", () => {
    const view = render(ui(true));
    const launcher = view.getByRole("button", { name: "SDP quick start · 1/3" });
    expect(launcher.getAttribute("title")).toBe("SDP quick start · 1/3");
    fireEvent.click(launcher);
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Dismiss SDP quick start" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.queryByRole("complementary")).toBeNull();
  });

  it("keeps the optional step skippable when custody is unavailable", () => {
    workspace.flags.custody = false;
    setQuickStart(key(), "wallet");
    const view = renderGuide();
    expect(view.queryByRole("link", { name: "Create wallet" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Skip wallet setup" }));
    expect(view.getByRole("link", { name: "Open Circle faucet" })).toBeTruthy();
  });

  it("works when browser storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    const view = renderGuide();
    fireEvent.click(view.getByRole("button", { name: "I already have an API key" }));
    expect(view.getByRole("heading", { name: "Set up a wallet" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Dismiss SDP quick start" }));
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
