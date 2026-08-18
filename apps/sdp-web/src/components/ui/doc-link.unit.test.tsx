import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocLink } from "./doc-link";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("DocLink", () => {
  it("resolves its target through the shared docs origin", () => {
    const markup = render(
      <DocLink path="/reference/policies" newTabHint="opens in a new tab">
        Read the policy reference
      </DocLink>
    );

    expect(markup).toContain(`href="${DEFAULT_SDP_DOCS_URL}/reference/policies"`);
    expect(markup).toContain("Read the policy reference");
  });

  it("links to the docs root when given no path", () => {
    const markup = render(<DocLink newTabHint="opens in a new tab">Docs</DocLink>);

    expect(markup).toContain(`href="${DEFAULT_SDP_DOCS_URL}"`);
  });

  it("opens externally without handing the docs tab a window opener", () => {
    const markup = render(
      <DocLink path="/reference/policies" newTabHint="opens in a new tab">
        Docs
      </DocLink>
    );

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("noreferrer");
    expect(markup).toContain("noopener");
  });

  it("announces the new tab to screen readers without showing the hint", () => {
    // A link that silently retargets the tab is disorienting for anyone not
    // watching the viewport. The hint is required by the type rather than read
    // from a catalog, so this primitive stays free of product copy.
    const markup = render(
      <DocLink path="/reference/policies" newTabHint="opens in a new tab">
        Docs
      </DocLink>
    );

    expect(markup).toContain("opens in a new tab");
    expect(markup).toContain("sr-only");
  });
});
