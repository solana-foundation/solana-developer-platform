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

  it("draws the issuance overview skeleton as a grid of cards", () => {
    const markup = renderToStaticMarkup(<IssuancePageSkeleton assetProfilesEnabled />);

    expect([...markup.matchAll(/data-loading-card="issuance-token"/g)]).toHaveLength(6);
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

    // The 44px mark beside the name and ticker chip, in the settled header's card.
    expect(markup).toMatch(/size-11[^"]*rounded-full/);
    expect(markup).toContain("h-8 w-52 max-w-full");
    expect(markup).toContain("h-5 w-16 rounded-md");
    // The two action buttons in the top-right corner.
    expect(markup.match(/h-8 w-\d+ rounded-lg/g)).toHaveLength(2);
  });

  it("reserves both identifier rows in the issuance-detail header", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);

    expect(markup).toContain('data-loading-meta-line="issuance-detail"');
    // Mint and token id, each elided to one line with its own copy button.
    expect(markup).toContain("data-loading-address-row");
    expect(markup).toContain("data-loading-token-id-row");
  });

  it("preserves the responsive and sticky geometry of the final routes", () => {
    const markup = renderAllRouteLoadingStates();

    expect(markup).toContain("data-loading-mobile-rows");
    expect(markup).toContain("data-loading-desktop-table");
    expect(markup).toContain("data-loading-metadata-rail");
    expect(markup).toContain("data-loading-api-key-table");
    // The organization/RPC card moved to Integrations (HOO-787), so the
    // settings route is members + appearance; a skeleton still reserving the
    // form leaves a gap that never fills.
    expect(markup).not.toContain("data-loading-settings-form");
    expect(markup).toContain("data-loading-settings-members");
    expect(markup.match(/data-loading-summary-rail/g)).toHaveLength(3);
    expect(markup.match(/data-loading-action-bar/g)).toHaveLength(3);
  });

  it("keeps a local loading state for the lazy issuance API playground", () => {
    const markup = renderIssuancePlaygroundLoading();

    expect(markup).toContain('data-loading-layout="issuance-playground"');
    expect(markup).toContain("lg:grid-cols-2");
  });
});
