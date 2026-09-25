import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CenteredDashboardTopBar,
  StackedDashboardTopBar,
  StandardDashboardTopBar,
} from "./dashboard-header";

describe("CenteredDashboardTopBar", () => {
  it("hides the redundant title on mobile and tablet while retaining its accessible heading", () => {
    const markup = renderToStaticMarkup(
      <CenteredDashboardTopBar
        title="Asset management"
        leadingContent={<span>Back</span>}
        trailingContent={<span>Trailing</span>}
        hideTitleOnMobile
      />
    );
    expect(markup).toContain("max-xl:sr-only");
    expect(markup).toContain("Asset management</h1>");
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });
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

describe("StackedDashboardTopBar", () => {
  it("stacks the menu button, the title and the action on a phone and rows them from md", () => {
    const markup = renderToStaticMarkup(
      <StackedDashboardTopBar
        navigation={<button type="button">Menu</button>}
        title="Requests"
        action={<a href="/new">New</a>}
        trailingContent={<span>Language</span>}
      />
    );

    expect(markup).toContain("data-dashboard-stacked-topbar");
    expect(markup).toContain("md:grid-cols-[minmax(0,1fr)_auto_auto]");
    expect(markup).toContain("col-start-1 row-start-1 flex items-center md:hidden");
    expect(markup).toContain(
      "col-span-3 row-start-2 min-w-0 md:col-span-1 md:col-start-1 md:row-start-1"
    );
    expect(markup).toContain("col-span-3 row-start-3");
    expect(markup).toContain("md:col-start-2 md:row-start-1");
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });

  it("keeps one screen-reader heading when the title is hidden", () => {
    const markup = renderToStaticMarkup(
      <StackedDashboardTopBar
        navigation={<button type="button">Menu</button>}
        title="Home"
        hideTitle
        trailingContent={<span>Language</span>}
      />
    );

    expect(markup).toContain('<h1 class="sr-only">Home</h1>');
    expect(markup).not.toContain("row-start-3");
  });
});
