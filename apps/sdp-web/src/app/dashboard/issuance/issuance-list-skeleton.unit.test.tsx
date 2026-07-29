import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";

function countOccurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe("IssuanceListSkeleton", () => {
  it("renders one placeholder row per requested item in list view, plus the add row", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton view="list" count={4} />);
    expect(markup).toContain('data-testid="issuance-list-skeleton"');
    expect(countOccurrences(markup, 'data-loading-row="issuance-token"')).toBe(4);
    // The add-asset affordance is part of the real layout, so it gets a
    // placeholder too — the dashed box after the rows.
    expect(countOccurrences(markup, "border-dashed")).toBe(1);
  });

  it("renders placeholder cards in grid view", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton view="grid" count={3} />);
    expect(markup).toContain('data-testid="issuance-grid-skeleton"');
    expect(countOccurrences(markup, 'data-loading-card="issuance-token"')).toBe(3);
    // Cards (and the add tile) keep the real tile's min height so the swap
    // doesn't move the page.
    expect(countOccurrences(markup, "min-h-[240px]")).toBe(3 + 1);
  });

  it("always renders at least one placeholder", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton view="list" count={0} />);
    expect(countOccurrences(markup, 'data-loading-row="issuance-token"')).toBe(1);
  });

  it("is decorative — the surrounding container owns the busy state", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton view="list" count={1} />);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("pulses, and stops for reduced motion", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton view="grid" count={1} />);
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain("motion-reduce:animate-none");
  });
});
