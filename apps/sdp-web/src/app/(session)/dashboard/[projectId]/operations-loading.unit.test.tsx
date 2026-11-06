import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import AllowlistLoading from "./allowlist/loading";
import ApiKeyDetailLoading from "./api-keys/[keyId]/loading";
import ApiKeysLoading from "./api-keys/loading";
import NewApiKeyLoading from "./api-keys/new/loading";
import IssuanceOverviewLoading from "./issuance/(overview)/loading";
import IssuanceDetailLoading from "./issuance/[tokenId]/loading";
import IssuanceCreateLoading from "./issuance/create/loading";
import SettingsLoading from "./settings/loading";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const EXPECTED_ROUTE_LAYOUTS = [
  "api-keys-list",
  "api-key-new",
  "api-key-detail",
  "allowlist",
  "settings",
];

function renderAllRouteLoadingStates(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeysLoading />
      <NewApiKeyLoading />
      <ApiKeyDetailLoading />
      <AllowlistLoading />
      <SettingsLoading />
    </I18nProvider>
  );
}

describe("operations route loading states", () => {
  it("gives every scoped route its own loading boundary", () => {
    const markup = renderAllRouteLoadingStates();

    for (const layout of EXPECTED_ROUTE_LAYOUTS) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
    }
  });

  it.each([
    ["list", IssuanceOverviewLoading],
    ["token", IssuanceDetailLoading],
    ["flow", IssuanceCreateLoading],
  ])("paints the Issuance %s skeleton", (layout, Loading) => {
    expect(renderToStaticMarkup(<Loading />)).toContain(`data-issuance-loading-layout="${layout}"`);
  });

  it("paints Settings with its onboarding section and no form", () => {
    const markup = renderAllRouteLoadingStates();

    expect(markup).not.toContain("data-loading-settings-form");
    expect(markup).toContain("data-loading-settings-onboarding");
  });
});
