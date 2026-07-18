import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkeletonBlock } from "./skeleton-block";

describe("SkeletonBlock", () => {
  it("includes the reduced-motion animation override in rendered markup", () => {
    const markup = renderToStaticMarkup(<SkeletonBlock />);

    expect(markup).toContain("animate-pulse");
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("merges caller classes and lets them override default styles", () => {
    const markup = renderToStaticMarkup(<SkeletonBlock className="h-4 rounded-full" />);

    expect(markup).toContain("h-4");
    expect(markup).toContain("rounded-full");
    expect(markup).not.toContain("rounded-md");
    expect(markup).toContain("motion-reduce:animate-none");
  });
});
