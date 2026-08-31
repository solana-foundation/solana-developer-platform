import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EmbeddedYieldConfigureLoading from "./embedded-yield/configure/loading";
import EmbeddedYieldIntegrateLoading from "./embedded-yield/integrate/loading";
import EmbeddedYieldLoading from "./embedded-yield/loading";

describe("Markets route loading states", () => {
  it.each([
    ["workspace", EmbeddedYieldLoading],
    ["integration guide", EmbeddedYieldIntegrateLoading],
  ])("renders the complete Embedded Yield %s skeleton", (_name, Loading) => {
    const markup = renderToStaticMarkup(<Loading />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("max-w-[63rem]");
    expect(markup).toContain("h-[121px]");
    expect(markup.match(/animate-pulse/g)).toHaveLength(6);
  });

  it("preserves the Earn workspace skeleton while configuration loads", () => {
    expect(renderToStaticMarkup(<EmbeddedYieldConfigureLoading />)).toBe(
      renderToStaticMarkup(<EmbeddedYieldLoading />)
    );
  });
});
