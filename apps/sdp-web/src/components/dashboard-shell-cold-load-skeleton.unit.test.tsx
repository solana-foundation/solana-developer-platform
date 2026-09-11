import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";
import { DashboardShell } from "./dashboard-shell";
import { FullscreenLoadingIndicator } from "./fullscreen-loading-indicator";

const pathnameMock = vi.hoisted(() => ({ value: "/dashboard" }));
const authMock = vi.hoisted(() => ({ isLoaded: false }));

vi.mock("@clerk/nextjs", () => ({
  // The cold load this suite covers is the window before the client session
  // resolves, so isLoaded drives which branch of the shell renders.
  useAuth: () => ({ isLoaded: authMock.isLoaded, isSignedIn: true, orgId: "org-cold-load" }),
  useUser: () => ({ isLoaded: authMock.isLoaded, isSignedIn: true, user: null }),
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
  useDashboardWorkspace: () => ({
    dashboardAccess: {
      capabilities: { canReadApprovals: true, canManageOrgSettings: true },
    },
    selectedProjectId: "project-cold-load",
    isSidebarOpen: true,
    setSidebarOpen: () => undefined,
    isProjectSwitching: false,
  }),
}));

function renderColdLoad(pathname: string): string {
  pathnameMock.value = pathname;
  return renderToStaticMarkup(
    <DashboardShell
      flags={{
        assetProfiles: false,
        custody: false,
        dvp: false,
        earn: false,
        heliusRings: false,
        issuance: false,
        markets: false,
        payments: true,
        policies: false,
        privateChannels: false,
      }}
    >
      <div>settled route content</div>
    </DashboardShell>
  );
}

// SAFETY: the page config only ever calls t(key) and uses the returned string,
// so an identity function stands in for the translator in these assertions.
const identityTranslate = ((key: string) => key) as Parameters<typeof getDashboardPageConfig>[1];

/** What the settled shell puts on its centred content column, per dashboard-shell.tsx. */
function settledContentWidthClassFor(pathname: string): string {
  const config = getDashboardPageConfig(pathname, identityTranslate, false, false);
  return config.contentWidthClass ?? "max-w-5xl";
}

/** The `max-w-*` the shell puts on its centred content column. */
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
    // A hardcoded width here paints the skeleton at a different measure from the
    // page that follows, which is the layout jump wearing a different costume.
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

    expect(getDashboardPageConfig("/dashboard/helius-rings", t, false, false).title).toBe(
      "Shared.dashboardShell.heliusRings"
    );
    expect(getDashboardPageConfig("/dashboard/members", t, false, false).title).toBe(
      "Shared.dashboardShell.settings"
    );
  });

  it("keeps the generic silhouette for callers that have no route in scope", () => {
    const markup = renderToStaticMarkup(<FullscreenLoadingIndicator />);

    expect(markup).toContain("data-shell-loading-skeleton");
    expect(markup).toContain("data-shell-loading-generic-content");
    expect(markup).not.toContain("data-loading-layout");
  });
});
