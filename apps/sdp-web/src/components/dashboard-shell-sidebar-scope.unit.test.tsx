// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { DashboardShell } from "./dashboard-shell";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, orgId: "org-sidebar-scope" }),
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: null }),
  SignInButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => undefined,
  useDashboardWorkspace: () => ({
    dashboardAccess: {
      capabilities: { canReadApprovals: true, canManageOrgSettings: true },
    },
    dashboardCacheScope: { orgId: "org-sidebar-scope", userId: "user-sidebar-scope" },
    selectedProjectId: "prj_test_sandbox",
    isSidebarOpen: true,
    setSidebarOpen: () => undefined,
    isProjectSwitching: false,
  }),
}));

vi.mock("@/components/workspace-switcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("@/components/sidebar-user-menu", () => ({ SidebarUserMenu: () => null }));
vi.mock("@/components/dashboard-quick-start", () => ({ DashboardQuickStart: () => null }));
vi.mock("@/components/network-debug-panel", () => ({ NetworkDebugPanel: () => null }));
vi.mock("@/components/sentry-user-context", () => ({ SentryUserContext: () => null }));
vi.mock("@/components/language-picker", () => ({ LanguagePicker: () => null }));

function shell(newDesign: boolean) {
  return (
    <DashboardShell
      flags={{
        assetProfiles: false,
        compliance: false,
        custody: false,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: true,
        markets: false,
        payments: true,
        privateChannels: false,
        ramps: false,
        newDesign,
      }}
    >
      <div>route content</div>
    </DashboardShell>
  );
}

function renderShell(pathname: string, newDesign: boolean): HTMLElement {
  setDashboardUrl(pathname, {});
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(shell(newDesign));
  return root;
}

const openNavigationSelector = 'button[aria-label="Shared.dashboardShell.openNavigation"]';

describe("dashboard shell sidebar on a route no area has redesigned", () => {
  it("puts the sidebar in the refresh scope on NEW DESIGN while the page keeps the base one", () => {
    const root = renderShell(`/dashboard/${SANDBOX_PROJECT.id}/issuance`, true);
    const main = root.querySelector("main");
    const sidebar = root.querySelector("aside");
    const page = root.querySelector("section");

    expect(main?.hasAttribute("data-sdp-new-design")).toBe(true);
    expect(main?.hasAttribute("data-sdp-theme")).toBe(false);
    expect(sidebar?.getAttribute("data-sdp-theme")).toBe("refresh");
    expect(sidebar?.getAttribute("style")).toContain("width:272px");
    expect(sidebar?.className).toContain("border-r");
    expect(page?.className).not.toContain("rounded-2xl");
  });

  it("keeps the previous design's sidebar and page card with NEW DESIGN off", () => {
    const root = renderShell(`/dashboard/${SANDBOX_PROJECT.id}/issuance`, false);
    const main = root.querySelector("main");
    const sidebar = root.querySelector("aside");
    const page = root.querySelector("section");

    expect(main?.hasAttribute("data-sdp-new-design")).toBe(false);
    expect(root.querySelector("[data-sdp-theme]")).toBeNull();
    expect(sidebar?.getAttribute("style")).toContain("width:296px");
    expect(sidebar?.className).not.toContain("border-r");
    expect(page?.className).toContain("rounded-2xl");
  });

  it("drops the phone's bottom bar on NEW DESIGN and opens the navigation from the header", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/issuance`, {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(shell(true)));

      expect(container.querySelector("[data-dashboard-bottom-nav]")).toBeNull();
      const menuButton = container.querySelector<HTMLButtonElement>(openNavigationSelector);
      expect(menuButton).not.toBeNull();
      expect(menuButton?.className).toContain("md:hidden");
      expect(container.querySelector("main")?.hasAttribute("data-sdp-theme")).toBe(false);
      expect(
        container.querySelector('[aria-label="Shared.dashboardShell.closeNavigationOverlay"]')
      ).toBeNull();

      await act(async () => menuButton?.click());

      const overlay = container.querySelector(
        '[aria-label="Shared.dashboardShell.closeNavigationOverlay"]'
      );
      expect(overlay).not.toBeNull();
      expect(overlay?.nextElementSibling?.getAttribute("data-sdp-theme")).toBe("refresh");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the phone's bottom bar, no header menu button and Project links with NEW DESIGN off", () => {
    const root = renderShell(`/dashboard/${PRODUCTION_PROJECT.id}/issuance`, false);
    expect(root.querySelector("[data-dashboard-bottom-nav]")).not.toBeNull();
    expect(
      root.querySelector(`aside a[href="/dashboard/${PRODUCTION_PROJECT.id}/payments"]`)
    ).not.toBeNull();
    expect(root.querySelector('a[href^="/dashboard/payments"]')).toBeNull();
    const toggles = root.querySelectorAll(openNavigationSelector);
    for (const toggle of toggles) {
      expect(toggle.className.split(" ")).toContain("hidden");
      expect(toggle.className).not.toContain("md:hidden");
    }
  });
});

describe("dashboard shell transactions tabs", () => {
  it("shows a tab only for transaction modules whose area is on", () => {
    const text =
      renderShell(`/dashboard/${SANDBOX_PROJECT.id}/payments/transactions`, false).textContent ??
      "";

    expect(text).toContain("DashboardPayments.transactions.modules.payments");
    expect(text).toContain("DashboardPayments.transactions.modules.issuance");
    for (const hidden of ["earn", "dvp", "private_channels", "rings"]) {
      expect(text).not.toContain(`DashboardPayments.transactions.modules.${hidden}`);
    }
  });
});
