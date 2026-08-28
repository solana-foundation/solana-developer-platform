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
  });

  it("names the audience for both paths", () => {
    expect(markup).toContain("DashboardMarkets.landing.treasuryAudience");
    expect(markup).toContain("DashboardMarkets.landing.programAudience");
  });

  it("titles the cards with the shared subnav labels so they cannot drift", () => {
    expect(markup).toContain("Shared.dashboardShell.treasurySolutions");
    expect(markup).toContain("Shared.dashboardShell.earnProgram");
  });
});
