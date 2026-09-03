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

  // The sidebar hides DvP behind this flag. A header tab that ignored it would
  // put a link to the gated workspace back on screen, one row above the
  // sidebar that just removed it.
  it("adds the DvP tab only when the flag is on", () => {
    const off = getDashboardPageConfig("/dashboard/markets/treasury-solutions", t, false, false);
    const on = getDashboardPageConfig(
      "/dashboard/markets/treasury-solutions",
      t,
      false,
      false,
      true
    );

    expect(off.routeTabs?.tabs.map((tab) => tab.href)).not.toContain("/dashboard/markets/dvp");
    expect(on.routeTabs?.tabs).toHaveLength(3);
    expect(on.routeTabs?.tabs.at(-1)).toEqual({
      href: "/dashboard/markets/dvp",
      label: "DashboardMarkets.dvp.navLabel",
    });
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
