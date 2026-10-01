// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./dashboard-shell";

const pathnameMock = vi.hoisted(() => ({ value: "/dashboard/issuance" }));

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

function renderShell(pathname: string, newDesign: boolean): HTMLElement {
  pathnameMock.value = pathname;
  const markup = renderToStaticMarkup(
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
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}

describe("dashboard shell sidebar on a route no area has redesigned", () => {
  it("puts the sidebar in the refresh scope on NEW DESIGN while the page keeps the base one", () => {
    const root = renderShell("/dashboard/issuance", true);
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
    const root = renderShell("/dashboard/issuance", false);
    const main = root.querySelector("main");
    const sidebar = root.querySelector("aside");
    const page = root.querySelector("section");

    expect(main?.hasAttribute("data-sdp-new-design")).toBe(false);
    expect(root.querySelector("[data-sdp-theme]")).toBeNull();
    expect(sidebar?.getAttribute("style")).toContain("width:296px");
    expect(sidebar?.className).not.toContain("border-r");
    expect(page?.className).toContain("rounded-2xl");
  });

  it("keeps the phone's bottom bar on a base page either way", () => {
    for (const newDesign of [true, false]) {
      const root = renderShell("/dashboard/issuance", newDesign);
      expect(root.querySelector("[data-dashboard-bottom-nav]")).not.toBeNull();
    }
  });
});
