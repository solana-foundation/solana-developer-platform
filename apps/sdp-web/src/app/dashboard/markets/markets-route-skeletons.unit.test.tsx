/**
 * Loading skeletons for the Markets routes.
 *
 * A skeleton is only doing its job if it is inert: it stands in for content
 * that is not there yet, so it must render without any of the data, context or
 * router the real workspace needs, and must announce nothing to a screen reader
 * that a sighted user would not also see. These render each one bare, which is
 * exactly the condition Next puts them in.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DvpCreateSkeleton,
  DvpTradeDetailSkeleton,
  DvpTradesSkeleton,
  EarnIntegrationGuideSkeleton,
  EarnProgramConfigureSkeleton,
  EmbeddedYieldPortfolioSkeleton,
  MarketsLandingSkeleton,
  TreasurySolutionsSkeleton,
} from "./markets-route-skeletons";

const SKELETONS = [
  ["MarketsLanding", MarketsLandingSkeleton],
  ["TreasurySolutions", TreasurySolutionsSkeleton],
  ["EmbeddedYieldPortfolio", EmbeddedYieldPortfolioSkeleton],
  ["EarnProgramConfigure", EarnProgramConfigureSkeleton],
  ["EarnIntegrationGuide", EarnIntegrationGuideSkeleton],
  ["DvpTrades", DvpTradesSkeleton],
  ["DvpTradeDetail", DvpTradeDetailSkeleton],
  ["DvpCreate", DvpCreateSkeleton],
] as const;

describe("Markets route skeletons", () => {
  it.each(SKELETONS)("%s renders with no props, data or context", (_name, Skeleton) => {
    const html = renderToStaticMarkup(<Skeleton />);

    expect(html.length).toBeGreaterThan(0);
  });

  // A placeholder is decoration. Copy inside one gets read out and then
  // replaced a moment later, which is worse than silence.
  it.each(SKELETONS)("%s carries no readable text", (_name, Skeleton) => {
    const html = renderToStaticMarkup(<Skeleton />);

    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
  });
});
