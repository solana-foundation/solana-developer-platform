import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EmbeddedYieldButtonBuilderLoading from "./embedded-yield/button-builder/loading";
import EmbeddedYieldConfigureLoading from "./embedded-yield/configure/loading";
import EmbeddedYieldLoading from "./embedded-yield/loading";

describe("Markets route loading states", () => {
  it.each([
    ["workspace", EmbeddedYieldLoading],
    ["button builder", EmbeddedYieldButtonBuilderLoading],
  ])("renders the complete Embedded Yield %s skeleton", (_name, Loading) => {
    const markup = renderToStaticMarkup(<Loading />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("max-w-7xl");
    expect(markup.match(/animate-pulse/g)).toHaveLength(14);
  });

  it("preserves the Earn workspace skeleton while configuration loads", () => {
    expect(renderToStaticMarkup(<EmbeddedYieldConfigureLoading />)).toBe(
      renderToStaticMarkup(<EmbeddedYieldLoading />)
    );
  });
});
