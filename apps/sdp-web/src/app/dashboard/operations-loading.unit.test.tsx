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
import { IssuancePlaygroundLoading } from "./issuance/issuance-playground-loading";
import MembersLoading from "./members/loading";
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
  "members",
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
      <MembersLoading />
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

  it("reserves the settled issuance-detail tab rail geometry", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);
    const tabList = markup.match(
      /<div class="([^"]*)" data-loading-tab-list="issuance-detail">([\s\S]*?)<\/div><div class="space-y-4 pt-1">/
    );
    const [, tabListClasses = "", tabPlaceholders = ""] = tabList ?? [];

    expect(tabList).not.toBeNull();
    expect(tabListClasses).toContain("overflow-x-auto");
    expect(tabPlaceholders.match(/shrink-0/g)).toHaveLength(6);
  });

  it("reserves active mobile identity geometry in the issuance-detail header", () => {
    const markup = renderToStaticMarkup(<IssuanceDetailLoading />);
    const identityRows = markup.match(
      /<div class="([^"]*)" data-loading-identity-rows="issuance-detail">/
    );
    const identityClasses = identityRows?.[1] ?? "";

    expect(identityRows).not.toBeNull();
    expect(identityClasses).toContain("min-h-14");
    expect(identityClasses).toContain("flex-col");
    expect(identityClasses).toContain("sm:min-h-6");
    expect(identityClasses).toContain("sm:flex-row");
    expect(markup).toContain("data-loading-address-row");
    expect(markup).toContain('data-loading-token-id-lines="2"');
    expect(markup).toContain("data-loading-token-id-continuation");
    expect(markup).toContain("sm:hidden");
  });

  it("preserves the responsive and sticky geometry of the final routes", () => {
    const markup = renderAllRouteLoadingStates();

    expect(markup).toContain("data-loading-mobile-rows");
    expect(markup).toContain("data-loading-desktop-table");
    expect(markup).toContain("data-loading-metadata-rail");
    expect(markup).toContain("data-loading-api-key-table");
    expect(markup).toContain("data-loading-settings-form");
    expect(markup.match(/data-loading-summary-rail/g)).toHaveLength(3);
    expect(markup.match(/data-loading-action-bar/g)).toHaveLength(3);
  });

  it("keeps a local loading state for the lazy issuance API playground", () => {
    const markup = renderIssuancePlaygroundLoading();

    expect(markup).toContain('data-loading-layout="issuance-playground"');
    expect(markup).toContain("lg:grid-cols-2");
  });
});
