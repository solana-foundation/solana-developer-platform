import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, translate, type TranslationValues } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  buildExpandedFields,
  type IssuanceTokenView,
  getTokenChips,
} from "./issuance-token-fields";
import { IssuanceTokenList } from "./issuance-token-list";

const messages = getMessages("en");
const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

function renderWithI18n(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

function baseToken(overrides: Partial<IssuanceTokenView> = {}): IssuanceTokenView {
  return {
    id: "tok_1",
    name: "Veritas Finance",
    symbol: "vUSD",
    status: "active",
    template: "stablecoin",
    imageUrl: null,
    mintAddress: null,
    totalSupply: "0",
    createdAt: "2026-07-17",
    deployedAt: null,
    decimals: 6,
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    description: null,
    uri: null,
    signingWalletId: null,
    assetProfile: null,
    ...overrides,
  };
}

const stablecoinProfile: IssuanceTokenView["assetProfile"] = {
  assetCategory: "stablecoin",
  assetType: "fiat_backed",
  assetTypeVersion: 1,
  issuanceMetadata: {
    asset: {
      issuerName: "Veritas Finance",
      pegCurrency: "USD",
      pegTarget: "1.00 USD",
      reserveAsset: "Cash & short-dated US Treasury bills",
      reserveCustodian: "Meridian Trust Bank, N.A.",
      redemptionEnabled: true,
      website: "https://veritas.finance",
    },
  },
};

describe("buildExpandedFields", () => {
  it("surfaces stablecoin type-specific fields when a profile is present", () => {
    const fields = buildExpandedFields(
      baseToken({ assetProfile: stablecoinProfile }),
      "type-aware",
      t,
      "en"
    );
    const byLabel = new Map(fields.map((field) => [field.label, field.value]));

    expect(byLabel.get(t("DashboardIssuance.list.decimals"))).toBe("6");
    expect(byLabel.get(t("DashboardIssuance.config.pegTarget"))).toBe("1.00 USD");
    expect(byLabel.get(t("DashboardIssuance.config.reserveAsset"))).toBe(
      "Cash & short-dated US Treasury bills"
    );
    expect(byLabel.get(t("DashboardIssuance.config.reserveCustodian"))).toBe(
      "Meridian Trust Bank, N.A."
    );
    // redemptionEnabled is a toggle → rendered as yes/no.
    expect(byLabel.get(t("DashboardIssuance.config.redemption"))).toBe(
      t("DashboardIssuance.list.yes")
    );
    // Website carries an external link.
    const website = fields.find((f) => f.label === t("DashboardIssuance.list.website"));
    expect(website?.href).toBe("https://veritas.finance");
  });

  it("falls back to core fields when there is no asset profile", () => {
    const fields = buildExpandedFields(baseToken(), "type-aware", t, "en");
    const labels = fields.map((field) => field.label);

    expect(labels).toContain(t("DashboardIssuance.list.type"));
    expect(labels).toContain(t("DashboardIssuance.list.maxSupply"));
    // No profile means no peg/reserve rows.
    expect(labels).not.toContain(t("DashboardIssuance.config.pegTarget"));
    const maxSupply = fields.find((f) => f.label === t("DashboardIssuance.list.maxSupply"));
    expect(maxSupply?.value).toBe(t("DashboardIssuance.list.unlimited"));
    const transfers = fields.find((f) => f.label === t("DashboardIssuance.list.transfers"));
    expect(transfers?.value).toBe(t("DashboardIssuance.list.unrestricted"));
  });

  it("core depth ignores the profile and shows core fields", () => {
    const fields = buildExpandedFields(
      baseToken({ assetProfile: stablecoinProfile, requiresAllowlist: true }),
      "core",
      t,
      "en"
    );
    const labels = fields.map((field) => field.label);
    expect(labels).toContain(t("DashboardIssuance.list.type"));
    expect(labels).not.toContain(t("DashboardIssuance.config.pegTarget"));
    const transfers = fields.find((f) => f.label === t("DashboardIssuance.list.transfers"));
    expect(transfers?.value).toBe(t("DashboardIssuance.list.restricted"));
  });
});

describe("getTokenChips", () => {
  it("uses category + subtype chips when a profile is present", () => {
    const chips = getTokenChips(baseToken({ assetProfile: stablecoinProfile }), t);
    const labels = chips.map((chip) => chip.label);
    expect(labels).toContain(t("DashboardIssuance.taxonomy.stablecoin"));
    expect(labels).toContain(t("DashboardIssuance.taxonomy.fiatBacked"));
  });

  it("falls back to a single template-derived chip without a profile", () => {
    const chips = getTokenChips(baseToken(), t);
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe(t("DashboardIssuance.templates.stablecoinName"));
  });
});

describe("IssuanceTokenList", () => {
  it("renders each token's symbol, name and a manage affordance without crashing", () => {
    const markup = renderWithI18n(
      <IssuanceTokenList
        tokens={[baseToken({ assetProfile: stablecoinProfile })]}
        manageVariant="button"
        fieldDepth="type-aware"
        onCreate={() => undefined}
      />
    );
    expect(markup).toContain("vUSD");
    expect(markup).toContain("Veritas Finance");
    expect(markup).toContain(t("DashboardIssuance.workspace.manage"));
    // Collapsed by default → chips visible, expanded field grid not rendered.
    expect(markup).toContain(t("DashboardIssuance.taxonomy.fiatBacked"));
  });
});
