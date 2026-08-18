import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DefinitionTerm } from "./definition-term";

const DEFINITION = "The on-chain account that defines a token and its supply.";

function render(): string {
  return renderToStaticMarkup(<DefinitionTerm definition={DEFINITION} term="Mint" />);
}

describe("DefinitionTerm", () => {
  it("exposes the term through a real button, not a hoverable span", () => {
    const markup = render();

    expect(markup).toContain('type="button"');
    expect(markup).toContain("Mint");
  });

  it("puts the definition in the document rather than only in the tooltip", () => {
    // The design system tooltip renders its content in a portal on open, so
    // server-rendered markup contains the trigger alone. A definition that only
    // exists on hover is unavailable to screen readers and to touch users, so it
    // is also rendered as visually hidden text.
    const markup = render();

    expect(markup).toContain(DEFINITION);
    expect(markup).toContain("sr-only");
  });

  it("associates the definition with the term it describes", () => {
    const markup = render();

    const describedBy = markup.match(/aria-describedby="([^"]+)"/);
    expect(describedBy).not.toBeNull();

    const referencedId = describedBy?.[1];
    expect(markup).toContain(`id="${referencedId}"`);
  });

  it("gives distinct terms distinct description ids", () => {
    // Two terms on one page sharing an id would point every description at the
    // first one, which is silent breakage rather than a visible bug.
    const markup = renderToStaticMarkup(
      <>
        <DefinitionTerm definition="First definition." term="Mint" />
        <DefinitionTerm definition="Second definition." term="Decimals" />
      </>
    );

    const ids = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
