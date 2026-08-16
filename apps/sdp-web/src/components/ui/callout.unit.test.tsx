import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Callout, type CalloutVariant } from "./callout";

const VARIANT_TOKENS: Record<CalloutVariant, string[]> = {
  info: ["border-info-border", "bg-info-bg", "text-info"],
  success: ["border-success-border", "bg-success-bg", "text-success"],
  warning: ["border-warning-border", "bg-warning-bg", "text-warning"],
  // `danger` is the variant name badge.tsx uses, and it maps to the error tokens.
  // Keeping the two vocabularies aligned stops a third status naming appearing.
  danger: ["border-error-border", "bg-error-bg", "text-error"],
};

describe("Callout", () => {
  it("paints each variant from the design system status tokens", () => {
    for (const [variant, tokens] of Object.entries(VARIANT_TOKENS)) {
      const markup = renderToStaticMarkup(
        <Callout variant={variant as CalloutVariant}>Body copy</Callout>
      );

      for (const token of tokens) {
        expect(markup).toContain(token);
      }
      expect(markup).toContain("Body copy");
    }
  });

  it("never hardcodes a colour outside the token set", () => {
    const markup = renderToStaticMarkup(<Callout variant="danger">Body copy</Callout>);

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(/);
  });

  it("stays out of the live region by default", () => {
    // A callout that renders with the page is read in document order already.
    // Wrapping static content in a live region makes screen readers announce it
    // out of sequence, so announcement is opt-in for callouts that appear later.
    const markup = renderToStaticMarkup(<Callout variant="danger">Body copy</Callout>);

    expect(markup).not.toContain("role=");
    expect(markup).not.toContain("aria-live");
  });

  it("announces assertively only when it appears in response to something", () => {
    const danger = renderToStaticMarkup(
      <Callout live variant="danger">
        Body copy
      </Callout>
    );
    const info = renderToStaticMarkup(
      <Callout live variant="info">
        Body copy
      </Callout>
    );

    expect(danger).toContain('role="alert"');
    expect(info).toContain('role="status"');
  });

  it("lets a caller lay its own content out when there is no title", () => {
    // An untitled callout that wraps its children makes the wrapper the only flex
    // item, so a caller asking for a row gets a column. Only wrap when a title
    // needs separating from the body.
    const markup = renderToStaticMarkup(
      <Callout className="flex sm:flex-row" variant="info">
        <span>first</span>
        <span>second</span>
      </Callout>
    );

    expect(markup).toMatch(
      /<div class="[^"]*flex[^"]*"><span>first<\/span><span>second<\/span><\/div>/
    );
  });

  it("renders a title without inventing a heading level", () => {
    // Heading elements here would collide with whatever page hosts the callout,
    // and a duplicate h1 has already shipped once on this dashboard.
    const markup = renderToStaticMarkup(
      <Callout title="Check the network" variant="warning">
        Body copy
      </Callout>
    );

    expect(markup).toContain("Check the network");
    expect(markup).not.toMatch(/<h[1-6]/);
  });
});
