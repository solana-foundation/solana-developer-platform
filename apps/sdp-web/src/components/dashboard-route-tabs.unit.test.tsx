import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardRouteTabs } from "./dashboard-route-tabs";

const tabs = [
  { href: "/dashboard/markets/treasury-solutions", label: "Treasury" },
  { href: "/dashboard/markets/embedded-yield", label: "Embedded Yield" },
] as const;

describe("DashboardRouteTabs", () => {
  it("marks the exact sibling route as current without creating query-tab state", () => {
    const markup = renderToStaticMarkup(
      <DashboardRouteTabs
        ariaLabel="Markets"
        pathname="/dashboard/markets/treasury-solutions/"
        tabs={tabs}
      />
    );

    expect(markup).toContain('href="/dashboard/markets/embedded-yield"');
    expect(markup).toContain('href="/dashboard/markets/treasury-solutions"');
    expect(markup.indexOf(">Treasury</a>")).toBeLessThan(markup.indexOf(">Embedded Yield</a>"));
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain("?tab=");
  });
});
