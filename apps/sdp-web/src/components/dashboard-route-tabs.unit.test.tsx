import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { DashboardRouteTabs } from "./dashboard-route-tabs";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const tabs = [
  { href: "/dashboard/markets/treasury-solutions", label: "Treasury" },
  { href: "/dashboard/markets/embedded-yield", label: "Embedded Yield" },
] as const;

describe("DashboardRouteTabs", () => {
  it("marks the exact sibling route as current and links each tab inside the URL's Project", () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/markets/treasury-solutions/`, {});
    const markup = renderToStaticMarkup(
      <DashboardRouteTabs
        ariaLabel="Markets"
        pathname="/dashboard/markets/treasury-solutions/"
        tabs={tabs}
      />
    );

    expect(markup).toContain(`href="/dashboard/${PRODUCTION_PROJECT.id}/markets/embedded-yield"`);
    expect(markup).toContain(
      `href="/dashboard/${PRODUCTION_PROJECT.id}/markets/treasury-solutions"`
    );
    expect(markup.indexOf(">Treasury</a>")).toBeLessThan(markup.indexOf(">Embedded Yield</a>"));
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain("?tab=");
  });
});
