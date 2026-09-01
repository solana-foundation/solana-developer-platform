import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EmbeddedYieldConfigureLoading from "./embedded-yield/configure/loading";
import EmbeddedYieldIntegrateLoading from "./embedded-yield/integrate/loading";
import EmbeddedYieldLoading from "./embedded-yield/loading";

describe("Markets route loading states", () => {
  it("matches the Embedded Yield portfolio while its first read loads", () => {
    const markup = renderToStaticMarkup(<EmbeddedYieldLoading />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-embedded-yield-loading="portfolio"');
    expect(markup).toContain("max-w-[63rem]");
    expect(markup).toContain("h-[121px]");
  });

  it("matches the strategy catalogue while configuration loads", () => {
    const markup = renderToStaticMarkup(<EmbeddedYieldConfigureLoading />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-embedded-yield-loading="configure"');
    expect(markup).toContain("max-w-7xl");
    expect(markup).toContain("h-20");
  });

  it("matches the code guide while integration loads", () => {
    const markup = renderToStaticMarkup(<EmbeddedYieldIntegrateLoading />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-embedded-yield-loading="integrate"');
    expect(markup).toContain("max-w-5xl");
    expect(markup).toContain("h-56");
  });
});
