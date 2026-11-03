// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";
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

function shell() {
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
        releaseChannel: "experimental",
        ramps: false,
      }}
    >
      <div>route content</div>
    </DashboardShell>
  );
}

function renderShell(pathname: string): HTMLElement {
  setDashboardUrl(pathname, {});
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(shell());
  return root;
}

const openNavigationSelector = 'button[aria-label="Shared.dashboardShell.openNavigation"]';

describe("dashboard shell sidebar on a base-design route", () => {
  it("puts the sidebar in the refresh scope while the page keeps the base one", () => {
    const root = renderShell(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`);
    const main = root.querySelector("main");
    const sidebar = root.querySelector("aside");

    expect(main?.hasAttribute("data-sdp-dashboard-shell")).toBe(true);
    expect(main?.hasAttribute("data-sdp-theme")).toBe(false);
    expect(sidebar?.getAttribute("data-sdp-theme")).toBe("refresh");
    expect(sidebar?.getAttribute("style")).toContain("width:280px");
    expect(sidebar?.className).toContain("border-r");
  });

  it("opens the phone's navigation from the header", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`, {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(shell()));

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
});
