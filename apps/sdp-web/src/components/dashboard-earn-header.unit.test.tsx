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

  it("centers the Treasury Solutions title without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets/treasury-solutions", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.treasurySolutions",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("centers the Embedded Yield title without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets/embedded-yield", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.earnProgram",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("centers the Embedded Yield button builder title without header tabs", () => {
    const config = getDashboardPageConfig(
      "/dashboard/markets/embedded-yield/button-builder",
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
});
