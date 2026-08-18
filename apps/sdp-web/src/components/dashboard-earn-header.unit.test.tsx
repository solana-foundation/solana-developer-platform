import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

describe("Earn dashboard headers", () => {
  it("labels the Earn overview", () => {
    expect(getDashboardPageConfig("/dashboard/markets/earn", t, false, false)).toMatchObject({
      title: "Shared.dashboardShell.earn",
      titlePosition: "center",
      headerTabs: {
        tabs: [
          { id: "opportunities", label: "DashboardEarn.tabs.opportunities" },
          { id: "positions", label: "DashboardEarn.tabs.positions" },
          { id: "playground", label: "DashboardEarn.tabs.playground" },
        ],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-none",
    });
  });

  it("centers the new-deposit title and links back to Earn", () => {
    const config = getDashboardPageConfig("/dashboard/markets/earn/deposit", t, false, false);
    const backAction = config.topBarLeadingContent as ReactElement<{
      href: string;
      label: string;
      compactOnMobile: boolean;
    }>;

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.earnNewDeposit",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(backAction.props).toMatchObject({
      href: "/dashboard/markets/earn",
      label: "Shared.dashboardShell.backToEarn",
      compactOnMobile: true,
    });
  });

  it("keeps strategy details in the Earn header context", () => {
    expect(
      getDashboardPageConfig("/dashboard/markets/earn/strategies/strategy-1", t, false, false)
    ).toMatchObject({
      title: "Shared.dashboardShell.earn",
      contentWidthClass: "max-w-none",
    });
  });
});
