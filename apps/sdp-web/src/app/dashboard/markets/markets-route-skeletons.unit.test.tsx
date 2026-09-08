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
  EmbeddedYieldPortfolioSkeleton,
  MarketsLandingSkeleton,
  TreasurySolutionsSkeleton,
} from "./markets-route-skeletons";

/**
 * The text a reader would actually hear, i.e. everything outside a tag.
 *
 * Deliberately a scanner rather than a `replace(/<[^>]*>/g, "")`: stripping
 * tags by regex is incomplete sanitization, and CodeQL rightly refuses it even
 * in a test. Nothing here sanitizes untrusted input, but the shape is the thing
 * that gets copied into somewhere that does.
 */
function textOutsideTags(markup: string): string {
  let text = "";
  let insideTag = false;

  for (const character of markup) {
    if (character === "<") {
      insideTag = true;
    } else if (character === ">") {
      insideTag = false;
    } else if (!insideTag) {
      text += character;
    }
  }

  return text.trim();
}

const SKELETONS = [
  ["MarketsLanding", MarketsLandingSkeleton],
  ["TreasurySolutions", TreasurySolutionsSkeleton],
  ["EmbeddedYieldPortfolio", EmbeddedYieldPortfolioSkeleton],
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
    expect(textOutsideTags(renderToStaticMarkup(<Skeleton />))).toBe("");
  });
});
