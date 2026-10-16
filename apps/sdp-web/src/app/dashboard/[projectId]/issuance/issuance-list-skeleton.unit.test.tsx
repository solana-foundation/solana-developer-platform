import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssuanceListSkeleton } from "./issuance-list-skeleton";

function countOccurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe("IssuanceListSkeleton", () => {
  it("renders placeholder cards, plus the add tile", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton count={3} />);
    expect(markup).toContain('data-testid="issuance-grid-skeleton"');
    expect(countOccurrences(markup, 'data-loading-card="issuance-token"')).toBe(3);
    // The add tile keeps the real tile's min height so the swap doesn't move
    // the page; the cards size from the same rows the real card renders.
    expect(countOccurrences(markup, "min-h-36")).toBe(1);
  });

  it("always renders at least one placeholder", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton count={0} />);
    expect(countOccurrences(markup, 'data-loading-card="issuance-token"')).toBe(1);
  });

  it("is decorative — the surrounding container owns the busy state", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton count={1} />);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("pulses, and stops for reduced motion", () => {
    const markup = renderToStaticMarkup(<IssuanceListSkeleton count={1} />);
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain("motion-reduce:animate-none");
  });
});
