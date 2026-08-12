import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import AllowlistLoading from "./allowlist/loading";
import EditApiKeyLoading from "./api-keys/[keyId]/edit/loading";
import ApiKeysLoading from "./api-keys/loading";
import NewApiKeyLoading from "./api-keys/new/loading";
import ApprovalDetailLoading from "./approvals/[approvalRequestId]/loading";
import ApprovalsLoading from "./approvals/loading";
import IssuanceOverviewLoading from "./issuance/(overview)/loading";
import IssuanceDetailLoading from "./issuance/[tokenId]/loading";
import IssuanceCreateLoading from "./issuance/create/loading";
import { IssuancePageSkeleton } from "./issuance/issuance-page-skeleton";
import { IssuancePlaygroundLoading } from "./issuance/issuance-playground-loading";
import PoliciesLoading from "./policies/loading";
import SettingsLoading from "./settings/loading";

const EXPECTED_ROUTE_LAYOUTS = [
  "issuance-overview",
  "issuance-create",
  "issuance-detail",
  "api-keys-list",
  "api-key-new",
  "api-key-edit",
  "policies",
  "approvals-list",
  "approval-detail",
  "allowlist",
  "settings",
];

function renderAllRouteLoadingStates(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <IssuanceOverviewLoading />
      <IssuanceCreateLoading />
      <IssuanceDetailLoading />
      <ApiKeysLoading />
      <NewApiKeyLoading />
      <EditApiKeyLoading />
      <PoliciesLoading />
      <ApprovalsLoading />
      <ApprovalDetailLoading />
      <AllowlistLoading />
      <SettingsLoading />
    </I18nProvider>
  );
}

function renderIssuancePlaygroundLoading(): string {
  return renderToStaticMarkup(<IssuancePlaygroundLoading />);
}

describe("operations route loading states", () => {
  it("gives every scoped route its own loading boundary", () => {
    const markup = renderAllRouteLoadingStates();

    for (const layout of EXPECTED_ROUTE_LAYOUTS) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
    }
  });

  it("announces the issuance overview as busy while it is loading", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <IssuanceOverviewLoading />
      </I18nProvider>
    );

    expect(markup).toContain('data-loading-layout="issuance-overview"');
    expect(markup).toContain('aria-busy="true"');
  });

  it("disables issuance token-card pulses when reduced motion is requested", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <IssuanceOverviewLoading />
      </I18nProvider>
    );
    const cards = [
      ...markup.matchAll(/<article class="[^"]*" data-loading-card="issuance-token"/g),
    ];
    const pulsingClasses = [...markup.matchAll(/class="([^"]*animate-pulse[^"]*)"/g)].map(
      (match) => match[1] ?? ""
    );

    expect(cards).toHaveLength(6);
    expect(pulsingClasses.length).toBeGreaterThan(0);
    expect(
      pulsingClasses.every((className) => className.includes("motion-reduce:animate-none"))
    ).toBe(true);
  });

  it("draws the issuance overview skeleton in the stored grid ⇄ list view", () => {
    const grid = renderToStaticMarkup(<IssuancePageSkeleton assetProfilesEnabled view="grid" />);
    const list = renderToStaticMarkup(<IssuancePageSkeleton assetProfilesEnabled view="list" />);

    expect([...grid.matchAll(/data-loading-card="issuance-token"/g)]).toHaveLength(6);
    expect(grid).not.toContain('data-loading-row="issuance-token"');
    expect([...list.matchAll(/data-loading-row="issuance-token"/g)]).toHaveLength(6);
    expect(list).not.toContain('data-loading-card="issuance-token"');
    expect(list).toContain('data-loading-view="list"');
  });

  it("falls back to the grid skeleton when no view preference is stored", () => {
    const markup = renderToStaticMarkup(<IssuancePageSkeleton assetProfilesEnabled />);

    expect(markup).toContain('data-loading-view="grid"');
  });

  it("reserves the settled issuance-detail tab rail geometry", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);
    const tabList = markup.match(
      /<div class="([^"]*)" data-loading-tab-list="issuance-detail">([\s\S]*?)<\/div><div class="space-y-4 pt-1">/
    );
    const [, tabListClasses = "", tabPlaceholders = ""] = tabList ?? [];

    expect(tabList).not.toBeNull();
    expect(tabListClasses).toContain("overflow-x-auto");
    // 7, not 6: the settled rail renders the compliance tab for admins (and for
    // non-admins on control-list tokens), which is the common case the skeleton
    // reserves for. Non-admins settle at 6 and lose one placeholder's width.
    expect(tabPlaceholders.match(/shrink-0/g)).toHaveLength(7);
  });

  it("reserves the settled issuance-detail header shell, mark and actions", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);

    // The card the settled header is, with the mark clipped by its own edge.
    expect(markup).toContain("relative isolate overflow-hidden rounded-2xl");
    // 208px hanging 40px off the left edge above lg; the same mark as a 56px
    // avatar in flow below it, so neither width is left unreserved.
    expect(markup).toContain("size-52");
    expect(markup).toContain("-left-10");
    expect(markup).toMatch(/size-14[^"]*rounded-full lg:hidden/);
    // The ticker, beside the mark above lg and under the name below it.
    expect(markup).toContain("left-[172px]");
    expect(markup).toMatch(/h-8 w-20 rounded-full lg:hidden/);
    // Actions float into the far corner above lg, in flow under a divider below.
    expect(markup).toContain("border-border-subtle pt-4 lg:hidden");
    expect(markup).toMatch(/absolute right-5 bottom-5 hidden[^"]*lg:flex/);
  });

  it("reserves both identifier rows in the issuance-detail header", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);
    const metaLine = markup.match(/<div class="([^"]*)" data-loading-meta-line="issuance-detail">/);
    const metaClasses = metaLine?.[1] ?? "";

    expect(metaLine).not.toBeNull();
    // Address and token id are both elided to one line, so the row is two stacked
    // lines below sm and one from sm up — no wrapping id to reserve for any more.
    expect(metaClasses).toContain("min-h-12");
    expect(metaClasses).toContain("flex-col");
    expect(metaClasses).toContain("sm:min-h-5");
    expect(metaClasses).toContain("sm:flex-row");
    expect(markup).toContain("data-loading-address-row");
    expect(markup).toContain("data-loading-token-id-row");
  });

  it("preserves the responsive and sticky geometry of the final routes", () => {
    const markup = renderAllRouteLoadingStates();

    expect(markup).toContain("data-loading-mobile-rows");
    expect(markup).toContain("data-loading-desktop-table");
    expect(markup).toContain("data-loading-metadata-rail");
    expect(markup).toContain("data-loading-api-key-table");
    expect(markup).toContain("data-loading-settings-form");
    // The settings route renders three cards; a skeleton short of that jumps the layout.
    expect(markup).toContain("data-loading-settings-members");
    expect(markup).toContain("data-loading-settings-appearance");
    expect(markup.match(/data-loading-summary-rail/g)).toHaveLength(3);
    expect(markup.match(/data-loading-action-bar/g)).toHaveLength(3);
  });

  it("keeps a local loading state for the lazy issuance API playground", () => {
    const markup = renderIssuancePlaygroundLoading();

    expect(markup).toContain('data-loading-layout="issuance-playground"');
    expect(markup).toContain("lg:grid-cols-2");
  });
});
