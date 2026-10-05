// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./dashboard-shell";

const pathnameMock = vi.hoisted(() => ({ value: "/dashboard/api-keys" }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, orgId: "org-sidebar-scope" }),
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: null }),
  SignInButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

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
    selectedProjectId: "project-sidebar-scope",
    isSidebarOpen: true,
    setSidebarOpen: () => undefined,
    isProjectSwitching: false,
  }),
}));

// The sidebar's account, workspace and quick-start widgets fetch their own data; the scope under
// test is on the containers around them.
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
        custody: false,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: true,
        markets: false,
        payments: true,
        policies: false,
        privateChannels: false,
        newDesign,
      }}
    >
      <div>route content</div>
    </DashboardShell>
  );
}

function renderShell(pathname: string, newDesign: boolean): HTMLElement {
  pathnameMock.value = pathname;
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(shell(newDesign));
  return root;
}

const openNavigationSelector = 'button[aria-label="Shared.dashboardShell.openNavigation"]';

describe("dashboard shell sidebar on a route no area has redesigned", () => {
  it("puts the sidebar in the refresh scope on NEW DESIGN while the page keeps the base one", () => {
    const root = renderShell("/dashboard/api-keys", true);
    const main = root.querySelector("main");
    const sidebar = root.querySelector("aside");
    const page = root.querySelector("section");

    expect(main?.hasAttribute("data-sdp-new-design")).toBe(true);
    expect(main?.hasAttribute("data-sdp-theme")).toBe(false);
    expect(sidebar?.getAttribute("data-sdp-theme")).toBe("refresh");
    expect(sidebar?.getAttribute("style")).toContain("width:280px");
    expect(sidebar?.className).toContain("border-r");
    expect(page?.className).not.toContain("rounded-2xl");
  });

  it("keeps the previous design's sidebar and page card with NEW DESIGN off", () => {
    const root = renderShell("/dashboard/api-keys", false);
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
    // A phone: the tablet query never matches, so nothing closes the slide-over.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    pathnameMock.value = "/dashboard/api-keys";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(shell(true)));

      expect(container.querySelector("[data-dashboard-bottom-nav]")).toBeNull();
      const menuButton = container.querySelector<HTMLButtonElement>(openNavigationSelector);
      expect(menuButton).not.toBeNull();
      expect(menuButton?.className).toContain("md:hidden");
      // The page itself stays on the base design: only its phone header gains the button.
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

  it("keeps the phone's bottom bar and no header menu button with NEW DESIGN off", () => {
    const root = renderShell("/dashboard/api-keys", false);
    expect(root.querySelector("[data-dashboard-bottom-nav]")).not.toBeNull();
    // The previous design's toggle carries the same label but is never displayed.
    const toggles = root.querySelectorAll(openNavigationSelector);
    for (const toggle of toggles) {
      expect(toggle.className.split(" ")).toContain("hidden");
      expect(toggle.className).not.toContain("md:hidden");
    }
  });
});
