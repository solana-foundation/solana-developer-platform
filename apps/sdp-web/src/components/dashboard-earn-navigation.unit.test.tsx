import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/dashboard-navigation-link", () => ({
  DashboardNavigationLink: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-workspace-switcher="true" />,
}));

import { DashboardMoreSheet } from "./dashboard-more-sheet";
import { getNavSections } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;
const options = {
  canReadApprovals: false,
  pendingApprovalCount: null,
  privateChannelsEnabled: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Earn dashboard navigation", () => {
  it("adds a Markets group with an Earn destination when the UI flag is enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_EARN_ENABLED", "true");

    const manage = getNavSections(t, options).find(
      (section) => section.title === "Shared.dashboardShell.manage"
    );
    const markets = manage?.items.find((item) => item.label === "Shared.dashboardShell.markets");

    expect(markets?.href).toBe("/dashboard/markets/earn");
    expect(markets?.children).toEqual([
      {
        label: "Shared.dashboardShell.earn",
        href: "/dashboard/markets/earn",
      },
    ]);
  });

  it("keeps Markets out of desktop and mobile navigation when the UI flag is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_EARN_ENABLED", "false");

    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
    expect(
      renderToStaticMarkup(
        <DashboardMoreSheet
          pathname="/dashboard"
          canReadApprovals={false}
          canManageOrgSettings={false}
          onClose={() => {}}
        />
      )
    ).not.toContain("/dashboard/markets/earn");
  });

  it("exposes the active Earn destination from the mobile More sheet", () => {
    vi.stubEnv("NEXT_PUBLIC_EARN_ENABLED", "true");

    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard/markets/earn/deposit"
        canReadApprovals={false}
        canManageOrgSettings={false}
        onClose={() => {}}
      />
    );

    expect(markup).toContain('href="/dashboard/markets/earn"');
    expect(markup).toContain("Shared.dashboardShell.earn");
    expect(markup).toContain('aria-current="page"');
  });
});
