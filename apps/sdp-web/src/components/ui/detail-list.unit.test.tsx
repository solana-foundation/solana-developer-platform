import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailList, DetailRow } from "./detail-list";

describe("DetailList", () => {
  it("pairs each label with its value as a description list", () => {
    const markup = renderToStaticMarkup(
      <DetailList>
        <DetailRow label="Type">Business</DetailRow>
        <DetailRow label="Created">Aug 5, 2026</DetailRow>
      </DetailList>
    );

    expect(markup).toMatch(/^<dl>/);
    expect(markup).toMatch(/<dt[^>]*>Type<\/dt><dd[^>]*>Business<\/dd>/);
    expect(markup).toMatch(/<dt[^>]*>Created<\/dt><dd[^>]*>Aug 5, 2026<\/dd>/);
  });

  it("sets rows on a subtle rule that the last row drops", () => {
    const markup = renderToStaticMarkup(<DetailRow label="Status">Active</DetailRow>);

    expect(markup).toContain("border-b border-border-subtle");
    expect(markup).toContain("last:border-b-0");
  });

  it("truncates a long value instead of pushing the label off the row", () => {
    // The label keeps its width; a long ID gives way and ends in an ellipsis.
    const markup = renderToStaticMarkup(<DetailRow label="External ID">ext_1234567890</DetailRow>);

    expect(markup).toMatch(/<dt class="[^"]*shrink-0[^"]*">/);
    expect(markup).toMatch(/<dd class="[^"]*min-w-0 truncate[^"]*">/);
  });

  it("passes the caller's classes to the list", () => {
    const markup = renderToStaticMarkup(
      <DetailList className="mt-6">
        <DetailRow label="Type">Business</DetailRow>
      </DetailList>
    );

    expect(markup).toMatch(/^<dl class="mt-6">/);
  });
});
