import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/components/dashboard-navigation-link", () => ({
  DashboardNavigationLink: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

import { EarnWorkspace } from "./earn-workspace";

// Server-render snapshot of the signed-out-of-positions state: the mock
// position store returns its empty server snapshot, so this covers the
// first-visit overview (empty positions + full curator catalogue).
const html = renderToStaticMarkup(<EarnWorkspace />);

describe("EarnWorkspace", () => {
  it("renders the positions section with its empty state and deposit entry", () => {
    expect(html).toContain("DashboardEarn.overview.positionsTitle");
    expect(html).toContain("DashboardEarn.overview.positionsEmpty");
    expect(html).toContain('href="/dashboard/markets/earn/deposit"');
  });

  it("renders one card per curator program with its start link", () => {
    for (const [id, label] of [
      ["steakhouse", "Steakhouse Financial"],
      ["gauntlet", "Gauntlet"],
      ["sentora", "Sentora"],
    ] as const) {
      expect(html).toContain(label);
      expect(html).toContain(`href="/dashboard/markets/earn/deposit?curator=${id}"`);
    }
  });

  it("shows the program decision hierarchy: APY lead, fit, risk, liquidity, assets", () => {
    expect(html).toContain("DashboardEarn.overview.indicativeApyRange");
    expect(html).toContain("DashboardEarn.overview.bestFor");
    expect(html).toContain("DashboardEarn.overview.riskRange");
    expect(html).toContain("DashboardEarn.overview.liquidityRange");
    expect(html).toContain("DashboardEarn.overview.fundingAssets");
  });

  it("keeps underlying holdings available behind each program drawer", () => {
    expect(html).toContain("DashboardEarn.overview.underlyingHoldings");
    expect(html).toContain("sdp-collapse");
  });
});
