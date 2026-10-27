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
import {
  TREASURY_POSITIONS_BODY,
  TREASURY_STRATEGIES_BODY,
  TREASURY_WALLETS_BODY,
} from "./treasury-solutions/treasury-layout";

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
  ["MarketsLanding", () => <MarketsLandingSkeleton earn dvp />],
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

// Treasury loads into the footprint it ends with: the same summary, tiles and tables the page
// draws, so nothing under them moves when the reads land.
describe("Treasury route skeleton", () => {
  const html = renderToStaticMarkup(<TreasurySolutionsSkeleton />);

  it("draws the summary, the wallet tiles and both tables in the page column's stack", () => {
    expect(html).toContain('data-loading-layout="treasury"');
    expect(html).toContain('data-earn-loading="summary"');
    expect(html).toContain('data-treasury-loading="wallets"');
    expect(occurrences(html, 'data-earn-loading="table"')).toBe(2);
    expect(html).not.toContain("max-w-[90rem]");
  });

  it("draws one wallet tile where tiles stack and two where they pair", () => {
    const wallets = html.slice(html.indexOf('data-treasury-loading="wallets"'));
    expect(occurrences(wallets, "rounded-card bg-surface-tile")).toBe(2);
    expect(wallets).toContain("hidden @xl:flex");
  });

  it("holds each section's ready footprint", () => {
    expect(html).toContain(TREASURY_WALLETS_BODY);
    expect(html).toContain(TREASURY_POSITIONS_BODY);
    expect(html).toContain(TREASURY_STRATEGIES_BODY);
    // The positions and strategies heads, five columns each.
    expect(occurrences(html, "<th ")).toBe(10);
  });
});

// Embedded Yield loads into its populated footprint: the summary Treasury shares, then the
// strategy table in the columns its rows render into.
describe("Embedded Yield route skeleton", () => {
  const html = renderToStaticMarkup(<EmbeddedYieldPortfolioSkeleton />);

  it("draws the summary and the strategy table in the page column's stack", () => {
    expect(html).toContain('data-embedded-yield-loading="portfolio"');
    expect(html).toContain('data-earn-loading="summary"');
    expect(occurrences(html, 'data-earn-loading="table"')).toBe(1);
    expect(html).not.toContain("max-w-[90rem]");
  });

  it("draws the strategy table's six columns and two rows", () => {
    expect(occurrences(html, "<th ")).toBe(6);
    expect(occurrences(html, "<tr ")).toBe(3);
  });
});

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

  it.each([
    [{ earn: true, dvp: true }, 2, 3],
    [{ earn: true, dvp: false }, 1, 2],
    [{ earn: false, dvp: true }, 1, 1],
  ])(
    "draws a landing group and a tile per path the page renders for %o",
    (modules, groups, tiles) => {
      const html = renderToStaticMarkup(<MarketsLandingSkeleton {...modules} />);
      expect(occurrences(html, "<section")).toBe(groups);
      // The ActionTile's 120px height and its control corners.
      expect(html.match(/h-30 w-full rounded-control/g)).toHaveLength(tiles);
    }
  );
});
