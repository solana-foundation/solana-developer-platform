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

describe("Markets dashboard navigation", () => {
  it("adds the ordered Treasury Solutions and Earn Program destinations when enabled", () => {
    const markets = findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: true }));

    expect(markets?.href).toBe("/dashboard/markets");
    expect(markets?.subnavKey).toBe("markets");
    expect(markets?.children).toEqual([
      {
        label: "Shared.dashboardShell.treasurySolutions",
        href: "/dashboard/markets/treasury-solutions",
      },
      {
        label: "Shared.dashboardShell.earnProgram",
        href: "/dashboard/markets/earn",
      },
    ]);
  });

  it("hides the Markets group when the module flag is off, whatever the sub-module says", () => {
    const options = navOptions({ marketsEnabled: false, earnEnabled: true });

    expect(findMarketsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
  });

  it("hides provider-backed Markets when the Earn runtime is off", () => {
    expect(
      findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: false }))
    ).toBeUndefined();
  });

  it("keeps Markets out of the mobile More sheet when the module flag is off", () => {
    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard"
        canReadApprovals={false}
        canManageOrgSettings={false}
        earnEnabled
        heliusRingsEnabled={false}
        marketsEnabled={false}
        onClose={() => {}}
      />
    );

    expect(markup).not.toContain('href="/dashboard/markets"');
  });

  it("exposes the active Markets destination from the mobile More sheet", () => {
    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard/markets/treasury-solutions"
        canReadApprovals={false}
        canManageOrgSettings={false}
        earnEnabled
        heliusRingsEnabled={false}
        marketsEnabled
        onClose={() => {}}
      />
    );

    expect(markup).toContain('href="/dashboard/markets"');
    expect(markup).toContain("Shared.dashboardShell.markets");
    expect(markup).toContain('aria-current="page"');
  });
});
