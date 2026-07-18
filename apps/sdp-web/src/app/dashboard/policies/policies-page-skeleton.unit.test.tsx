import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PoliciesPageSkeleton } from "./policies-page-skeleton";

describe("PoliciesPageSkeleton", () => {
  it("announces its cold-load state as busy", () => {
    const markup = renderToStaticMarkup(<PoliciesPageSkeleton />);

    expect(markup).toMatch(/^<div[^>]*aria-busy="true"/);
  });
});
