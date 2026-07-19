import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CenteredDashboardTopBar, StandardDashboardTopBar } from "./dashboard-shell";

describe("CenteredDashboardTopBar", () => {
  it("gives a 390px viewport a full-width title row without widening the document", () => {
    const markup = renderToStaticMarkup(
      <CenteredDashboardTopBar
        title="New Counterparty"
        leadingContent={<span>Back</span>}
        trailingContent={<span>Sandbox</span>}
      />
    );

    expect(markup).toContain("data-dashboard-centered-topbar");
    expect(markup).toContain("grid-cols-[auto_minmax(0,1fr)]");
    expect(markup).toContain("col-span-2 row-start-2");
    expect(markup).toContain("sm:grid-cols-[1fr_auto_1fr]");
    expect(markup).toContain("sm:col-span-1 sm:col-start-2 sm:row-start-1");
  });
});

describe("StandardDashboardTopBar", () => {
  it("moves long mobile titles below the controls before restoring the desktop row", () => {
    const markup = renderToStaticMarkup(
      <StandardDashboardTopBar
        title="Recurring payment"
        leadingContent={<span>Menu</span>}
        trailingContent={<span>Language and account</span>}
      />
    );

    expect(markup).toContain("data-dashboard-standard-topbar");
    expect(markup).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(markup).toContain("sm:grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(markup).toContain("col-span-2 row-start-2");
    expect(markup).toContain("sm:col-span-1 sm:col-start-2 sm:row-start-1");
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });
});
