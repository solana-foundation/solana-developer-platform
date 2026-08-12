import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-workspace-switcher="true" />,
}));

import { DashboardMoreSheet } from "./dashboard-more-sheet";
import { getNavSections } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;

function navOptions(flags: { marketsEnabled: boolean; earnEnabled: boolean }) {
  return {
    canReadApprovals: false,
    heliusRingsEnabled: false,
    pendingApprovalCount: null,
    privateChannelsEnabled: false,
    ...flags,
  };
}

function findMarketsItem(options: ReturnType<typeof navOptions>) {
  return getNavSections(t, options)
    .find((section) => section.title === "Shared.dashboardShell.manage")
    ?.items.find((item) => item.label === "Shared.dashboardShell.markets");
}

describe("Earn dashboard navigation", () => {
  it("adds a Markets group with an Earn destination when both flags are enabled", () => {
    const markets = findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: true }));

    expect(markets?.href).toBe("/dashboard/markets/earn");
    expect(markets?.subnavKey).toBe("markets");
    expect(markets?.children).toEqual([
      {
        label: "Shared.dashboardShell.earn",
        href: "/dashboard/markets/earn",
      },
    ]);
  });

  it("hides the Markets group when the module flag is off, whatever the sub-module says", () => {
    const options = navOptions({ marketsEnabled: false, earnEnabled: true });

    expect(findMarketsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
  });

  it("hides the Markets group rather than rendering it empty when every sub-module is off", () => {
    const options = navOptions({ marketsEnabled: true, earnEnabled: false });

    expect(findMarketsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
  });

  it("keeps Earn out of the mobile More sheet when either flag is off", () => {
    for (const flags of [
      { marketsEnabled: false, earnEnabled: true },
      { marketsEnabled: true, earnEnabled: false },
    ]) {
      expect(
        renderToStaticMarkup(
          <DashboardMoreSheet
            pathname="/dashboard"
            canReadApprovals={false}
            canManageOrgSettings={false}
            heliusRingsEnabled={false}
            onClose={() => {}}
            {...flags}
          />
        )
      ).not.toContain("/dashboard/markets/earn");
    }
  });

  it("exposes the active Earn destination from the mobile More sheet", () => {
    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard/markets/earn/deposit"
        canReadApprovals={false}
        canManageOrgSettings={false}
        earnEnabled
        heliusRingsEnabled={false}
        marketsEnabled
        onClose={() => {}}
      />
    );

    expect(markup).toContain('href="/dashboard/markets/earn"');
    expect(markup).toContain("Shared.dashboardShell.earn");
    expect(markup).toContain('aria-current="page"');
  });
});
