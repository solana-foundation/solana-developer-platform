import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders an asChild button's iconLeft inside its child element, ahead of the child's content", () => {
    const markup = renderToStaticMarkup(
      <Button asChild iconLeft={<svg data-icon="left" />}>
        <a href="/wallets">Manage</a>
      </Button>
    );

    expect(markup).toMatch(
      /^<a [^>]*href="\/wallets"[^>]*><svg data-icon="left"><\/svg>Manage<\/a>$/
    );
  });
});
