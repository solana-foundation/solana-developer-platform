import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { projectHref } from "@/lib/dashboard-project-path";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";
import { getDashboardPageConfig } from "./dashboard-header";
import { DashboardLoadingScreen } from "./dashboard-loading-screen";
import { DashboardShell } from "./dashboard-shell";

const authMock = vi.hoisted(() => ({ isLoaded: false }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: authMock.isLoaded, isSignedIn: true, orgId: "org-cold-load" }),
  useUser: () => ({ isLoaded: authMock.isLoaded, isSignedIn: true, user: null }),
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
    selectedProjectId: "prj_test_sandbox",
    isSidebarOpen: true,
    setSidebarOpen: () => undefined,
    isProjectSwitching: false,
  }),
}));

function renderColdLoad(pathname: string): string {
  setDashboardUrl(projectHref(SANDBOX_PROJECT.id, pathname), {});
  return renderToStaticMarkup(
    <DashboardShell
      flags={{
        assetProfiles: false,
        compliance: false,
        custody: false,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: false,
        markets: false,
        payments: true,
        policies: false,
        privateChannels: false,
        newDesign: false,
        ramps: true,
      }}
    >
      <div>settled route content</div>
    </DashboardShell>
  );
}

const identityTranslate = ((key: string) => key) as Parameters<typeof getDashboardPageConfig>[1];

function settledContentWidthClassFor(pathname: string): string {
  const config = getDashboardPageConfig(pathname, identityTranslate, false, false, []);
  return config.contentWidthClass ?? "max-w-5xl";
}

function contentWidthClassOf(markup: string): string {
  const widths = [...markup.matchAll(/mx-auto[^"]*?\s(max-w-[\w-]+)/g)].map((match) => match[1]);
  return widths[0] ?? "none found";
}

describe("dashboard cold load", () => {
  it("paints the route's own skeleton instead of the generic silhouette", () => {
    const markup = renderColdLoad("/dashboard");

    expect(markup).toContain("data-shell-loading-skeleton");
    expect(markup).toContain('data-loading-layout="home"');
    expect(markup).not.toContain("data-shell-loading-generic-content");
  });

  it("paints a different skeleton per route rather than one shape everywhere", () => {
    const transactions = renderColdLoad("/dashboard/payments/transactions");
    const policies = renderColdLoad("/dashboard/policies");

    expect(transactions).toContain('data-loading-layout="payments-transactions"');
    expect(transactions).not.toContain('data-loading-layout="home"');
    expect(policies).not.toContain('data-loading-layout="payments-transactions"');
    expect(transactions).not.toBe(policies);
  });

  it("paints Helius Rings and the Members redirect with their own skeletons, not Home's", () => {
    const helius = renderColdLoad("/dashboard/helius-rings");
    const members = renderColdLoad("/dashboard/members");

    expect(helius).toContain('data-loading-layout="helius-rings"');
    expect(helius).not.toContain('data-loading-layout="home"');
    expect(members).toContain('data-loading-layout="settings"');
    expect(members).not.toContain('data-loading-layout="home"');
  });

  it("holds the skeleton to the same content width the settled route uses", () => {
    for (const pathname of [
      "/dashboard",
      "/dashboard/policies",
      "/dashboard/api-keys/new",
      "/dashboard/helius-rings",
    ]) {
      const settledWidth = settledContentWidthClassFor(pathname);

      expect(contentWidthClassOf(renderColdLoad(pathname))).toBe(settledWidth);
    }
  });

  it("pads the skeleton like the settled shell's content section", () => {
    const markup = renderColdLoad("/dashboard");

    expect(markup).toContain("px-3 py-5 md:p-6");
    expect(markup).not.toContain("px-6 py-8");
  });

  it("titles Helius Rings and the Members redirect instead of falling through to Home", () => {
    const t = identityTranslate;

    expect(getDashboardPageConfig("/dashboard/helius-rings", t, false, false, []).title).toBe(
      "Shared.dashboardShell.heliusRings"
    );
    expect(getDashboardPageConfig("/dashboard/members", t, false, false, []).title).toBe(
      "Shared.dashboardShell.settings"
    );
  });

  it("uses identical frames during preparation and client authentication", () => {
    for (const pathname of ["/dashboard", "/dashboard/payments/transactions"]) {
      const coldLoad = renderColdLoad(pathname);
      const preparation = renderToStaticMarkup(<DashboardLoadingScreen pathname={pathname} />);
      expect(preparation).toBe(coldLoad);
    }
  });

  it("keeps deep links route-specific and preserves a collapsed sidebar", () => {
    const markup = renderToStaticMarkup(
      <DashboardLoadingScreen
        pathname="/dashboard/wallets?view=list#activity"
        isSidebarOpen={false}
      />
    );
    expect(markup).toContain('data-wallet-loading-layout="wallets-overview"');
    expect(markup).not.toContain('data-loading-layout="home"');
    expect(markup).toContain("width:64px");
  });
});
