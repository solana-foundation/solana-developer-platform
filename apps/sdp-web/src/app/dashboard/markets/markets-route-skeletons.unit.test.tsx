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

/** How many times an attribute or tag opens in the markup. */
function occurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

// Each DvP skeleton mirrors the page it stands in for. These pin the parts
// that went stale before: a five-step wizard with a side rail stood in for a
// two-step create form, and two coarse blocks for the trade page.
describe("DvP route skeletons", () => {
  it("draws the trades list as the toolbar card and its six-column table", () => {
    const html = renderToStaticMarkup(<DvpTradesSkeleton />);

    expect(html).toContain('data-loading-layout="dvp-trades"');
    expect(occurrences(html, "<th ")).toBe(6);
    // The toolbar grid the page's TradesToolbar lays out: search, status, create.
    expect(html).toContain("md:grid-cols-[minmax(280px,1fr)_190px_auto]");
    expect(html).not.toContain("max-w-[63rem]");
  });

  it("draws the trade page as two delivery cards, then settle and cancel", () => {
    const html = renderToStaticMarkup(<DvpTradeDetailSkeleton />);

    expect(occurrences(html, "data-loading-leg-card")).toBe(2);
    expect(html).toContain('data-loading-close-action="settle"');
    expect(html).toContain('data-loading-close-action="cancel"');
    // The page's column and its side-by-side delivery cards from md up.
    expect(html).toContain("max-w-[63rem]");
    expect(html).toContain("mt-4 grid gap-4 md:grid-cols-2");
  });

  it("draws the create flow as a two-step wizard with both sides and no rail", () => {
    const html = renderToStaticMarkup(<DvpCreateSkeleton />);

    expect(occurrences(html, "data-loading-step")).toBe(2);
    expect(occurrences(html, "data-loading-create-leg")).toBe(2);
    expect(html).not.toContain("440px");
    // WizardFrame's default width, on the stepper, the stage and the footer alike.
    expect(occurrences(html, "max-w-3xl")).toBe(3);
    expect(html).not.toContain("max-w-6xl");
  });
});
