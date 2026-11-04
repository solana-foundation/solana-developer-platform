import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardFlags } from "@/flags/dashboard";
import { EnglishI18n } from "@/test/i18n";
import { getDashboardPageConfig } from "./dashboard-header";
import { DashboardLoadingScreen } from "./dashboard-loading-screen";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: vi.fn(),
}));

const FLAGS: DashboardFlags = {
  assetProfiles: false,
  compliance: false,
  custody: false,
  dvp: false,
  earn: false,
  heliusRings: false,
  issuance: false,
  markets: false,
  payments: true,
  privateChannels: false,
  releaseChannel: "experimental",
  ramps: true,
};

function renderLoadingScreen(pathname: string): string {
  return renderToStaticMarkup(
    <EnglishI18n>
      <DashboardLoadingScreen pathname={pathname} flags={FLAGS} />
    </EnglishI18n>
  );
}

const identityTranslate = ((key: string) => key) as Parameters<typeof getDashboardPageConfig>[1];

function settledContentWidthClassFor(pathname: string): string {
  const config = getDashboardPageConfig(pathname, identityTranslate, true);
  return config.contentWidthClass ?? "max-w-5xl";
}

function contentWidthClassOf(markup: string): string {
  const widths = [...markup.matchAll(/mx-auto[^"]*?\s(max-w-[\w-]+)/g)].map((match) => match[1]);
  return widths[0] ?? "none found";
}

describe("DashboardLoadingScreen", () => {
  it("paints the route's own skeleton", () => {
    const markup = renderLoadingScreen("/dashboard");

    expect(markup).toContain("data-shell-loading-skeleton");
    expect(markup).toContain('data-loading-layout="home"');
  });

  it("paints a different skeleton per route rather than one shape everywhere", () => {
    const transactions = renderLoadingScreen("/dashboard/payments/transactions");
    const policies = renderLoadingScreen("/dashboard/policies");

    expect(transactions).toContain('data-loading-layout="payments-transactions"');
    expect(transactions).not.toContain('data-loading-layout="home"');
    expect(policies).not.toContain('data-loading-layout="payments-transactions"');
    expect(transactions).not.toBe(policies);
  });

  it("paints Helius Rings and the Members redirect with their own skeletons, not Home's", () => {
    const helius = renderLoadingScreen("/dashboard/helius-rings");
    const members = renderLoadingScreen("/dashboard/members");

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

      expect(contentWidthClassOf(renderLoadingScreen(pathname))).toBe(settledWidth);
    }
  });

  it("pads the skeleton like the settled shell's content section", () => {
    const markup = renderLoadingScreen("/dashboard");

    expect(markup).toContain("px-3 py-5 md:p-6");
    expect(markup).not.toContain("px-6 py-8");
  });

  it("titles Helius Rings and the Members redirect instead of falling through to Home", () => {
    const t = identityTranslate;

    expect(getDashboardPageConfig("/dashboard/helius-rings", t).title).toBe(
      "Shared.dashboardShell.heliusRings"
    );
    expect(getDashboardPageConfig("/dashboard/members", t).title).toBe(
      "Shared.organizationSettings.title"
    );
  });

  it("keeps deep links route-specific and preserves a collapsed sidebar", () => {
    const markup = renderToStaticMarkup(
      <EnglishI18n>
        <DashboardLoadingScreen
          pathname="/dashboard/wallets?view=list#activity"
          isSidebarOpen={false}
        />
      </EnglishI18n>
    );
    expect(markup).toContain('data-wallet-loading-layout="wallets-overview"');
    expect(markup).not.toContain('data-loading-layout="home"');
    expect(markup).toContain("width:64px");
  });
});
