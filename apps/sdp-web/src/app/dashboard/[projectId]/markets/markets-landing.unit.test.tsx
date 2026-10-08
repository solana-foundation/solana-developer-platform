import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

import { MarketsLanding } from "./markets-landing";

describe("MarketsLanding", () => {
  let markup = "";

  beforeAll(async () => {
    markup = renderToStaticMarkup(await MarketsLanding());
  });

  it("links each path to its existing subnav destination", () => {
    expect(markup).toContain('href="/dashboard/markets/treasury-solutions"');
    expect(markup).toContain('href="/dashboard/markets/embedded-yield"');
    expect(markup).toContain('href="/dashboard/markets/dvp"');
  });

  it("groups earning and settlement paths under separate headings", () => {
    expect(markup).toContain('aria-labelledby="markets-earn-heading"');
    expect(markup).toContain('id="markets-earn-heading"');
    expect(markup).toContain("DashboardMarkets.landing.earnHeading");
    expect(markup).toContain('aria-labelledby="markets-settlement-heading"');
    expect(markup).toContain('id="markets-settlement-heading"');
    expect(markup).toContain("DashboardMarkets.landing.settlementHeading");
    expect(markup).not.toContain("DashboardMarkets.landing.eyebrow");
    expect(markup).not.toContain("DashboardMarkets.landing.description");
  });

  it("keeps audience context on the two earn paths", () => {
    expect(markup).toContain("DashboardMarkets.landing.treasuryAudience");
    expect(markup).toContain("DashboardMarkets.landing.programAudience");
    expect(markup).not.toContain("DashboardMarkets.dvp.landingAudience");
  });

  it("titles the cards with the shared subnav labels so they cannot drift", () => {
    expect(markup).toContain("Shared.dashboardShell.treasurySolutions");
    expect(markup).toContain("Shared.dashboardShell.earnProgram");
  });
});
