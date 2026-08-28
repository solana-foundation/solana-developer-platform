import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EarnButtonBuilderLoading from "./earn/button-builder/loading";
import EarnLoading from "./earn/loading";
import EmbeddedYieldButtonBuilderLoading from "./embedded-yield/button-builder/loading";
import EmbeddedYieldLoading from "./embedded-yield/loading";

describe("Markets route loading states", () => {
  it("preserves the Earn workspace skeleton on the canonical route", () => {
    expect(renderToStaticMarkup(<EmbeddedYieldLoading />)).toBe(
      renderToStaticMarkup(<EarnLoading />)
    );
  });

  it("preserves the Earn builder skeleton on the canonical route", () => {
    expect(renderToStaticMarkup(<EmbeddedYieldButtonBuilderLoading />)).toBe(
      renderToStaticMarkup(<EarnButtonBuilderLoading />)
    );
  });
});
