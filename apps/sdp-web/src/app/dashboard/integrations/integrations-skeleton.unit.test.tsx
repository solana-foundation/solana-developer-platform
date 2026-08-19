import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationDetailLoading from "./[provider]/loading";
import { IntegrationDetailSkeleton } from "./integrations-skeleton";

/**
 * A dashboard route has two loading paths: the server `loading.tsx` on a hard
 * navigation, and the shell's skeleton switch on a client one. They used to be
 * hand-duplicated markup, so the Connection section reached only one of them
 * and a client navigation flashed a skeleton one block short of the page.
 */
describe("integration detail skeleton", () => {
  it("renders the same markup down both loading paths", () => {
    expect(renderToStaticMarkup(<IntegrationDetailLoading />)).toBe(
      renderToStaticMarkup(<IntegrationDetailSkeleton />)
    );
  });

  it("carries a block for every section the detail page renders", () => {
    const markup = renderToStaticMarkup(<IntegrationDetailSkeleton />);
    // Header, Connection, About, How it connects, Resources — the RPC family
    // renders the most sections, and the skeleton is sized for it.
    expect(markup.match(/rounded-2xl/g)).toHaveLength(4);
  });
});
