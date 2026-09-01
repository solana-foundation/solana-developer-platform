import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

describe("Markets dashboard headers", () => {
  it("centers the Markets landing title without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("uses the shared Markets title and route tabs for Treasury", () => {
    const config = getDashboardPageConfig("/dashboard/markets/treasury-solutions", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "left",
      headerVariant: "markets",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.routeTabs?.tabs).toEqual([
      {
        href: "/dashboard/markets/treasury-solutions",
        label: "Shared.dashboardShell.treasurySolutions",
      },
      {
        href: "/dashboard/markets/embedded-yield",
        label: "Shared.dashboardShell.earnProgram",
      },
    ]);
  });

  it("uses the shared Markets title and route tabs for Embedded Yield", () => {
    const config = getDashboardPageConfig("/dashboard/markets/embedded-yield", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "left",
      headerVariant: "markets",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.routeTabs?.tabs).toHaveLength(2);
  });

  it("centers the Embedded Yield integration title without header tabs", () => {
    const config = getDashboardPageConfig(
      "/dashboard/markets/embedded-yield/integrate",
      t,
      false,
      false
    );

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("uses the integration title for Embedded Yield configuration", () => {
    const config = getDashboardPageConfig(
      "/dashboard/markets/embedded-yield/configure",
      t,
      false,
      false
    );

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
  });
});
