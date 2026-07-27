import type { PaymentsDashboardWallet } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { AuthorityRoleKey } from "./asset-overview-hero";
import {
  buildOverviewHeroData,
  getTokenChips,
  type IssuanceTokenView,
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
    mintAuthority: null,
    metadataAuthority: null,
    freezeAuthority: null,
    permanentDelegate: null,
    assetProfile: null,
    ...overrides,
  };
}

function wallet(publicKey: string): PaymentsDashboardWallet {
  return {
    id: `id_${publicKey}`,
    walletId: `wid_${publicKey}`,
    publicKey,
    label: "Treasury",
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

describe("buildOverviewHeroData", () => {
  const MANAGED = "MANAGEDpubkey1111111111111111111111111111111";
  const EXTERNAL = "EXTERNALpubkey222222222222222222222222222222";
  const rowFor = (data: ReturnType<typeof buildOverviewHeroData>, role: AuthorityRoleKey) =>
    data.authorityRows.find((authorityRow) => authorityRow.role === role);

  it("resolves each applicable authority's control against the org custody wallets", () => {
    const data = buildOverviewHeroData(
      baseToken({
        mintAuthority: MANAGED,
        freezeAuthority: MANAGED,
        metadataAuthority: MANAGED,
      }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    // mint + freeze + metadata are set & custodied by the org → green (sdp).
    for (const role of ["mint", "freeze", "metadata"] as const) {
      const row = rowFor(data, role);
      expect(row?.applicable).toBe(true);
      expect(row?.address).toBe(MANAGED);
      expect(row?.control).toBe("sdp");
    }
    // The permanent delegate is unset → not applicable, so the glyph isn't drawn.
    expect(rowFor(data, "permanentDelegate")?.applicable).toBe(false);
  });

  it("marks an authority held outside the org as external", () => {
    const data = buildOverviewHeroData(
      baseToken({
        mintAuthority: MANAGED,
        freezeAuthority: EXTERNAL,
        metadataAuthority: MANAGED,
      }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "freeze")?.control).toBe("external");
    expect(rowFor(data, "mint")?.control).toBe("sdp");
    expect(rowFor(data, "metadata")?.control).toBe("sdp");
  });

  it("reports control as unknown when no custody wallets are loaded", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED, freezeAuthority: MANAGED }),
      [],
      t,
      "en"
    );

    // Without wallets we can't classify custody → control "unknown" (muted glyph),
    // but the address itself is still resolvable from the row.
    const mint = rowFor(data, "mint");
    expect(mint?.control).toBe("unknown");
    expect(mint?.address).toBe(MANAGED);
  });

  // The authority popovers render the same compact identity badge as the signer
  // tile, so each row carries a resolved holder — not just a bare address.
  it("resolves an SDP-held authority to its named custody wallet", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "mint")?.identity).toEqual({
      state: "managed",
      name: "Treasury",
      provider: null,
      publicKey: MANAGED,
    });
  });

  it("carries the bare address for an externally held authority", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED, freezeAuthority: EXTERNAL }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "freeze")?.identity).toEqual({
      state: "external",
      publicKey: EXTERNAL,
    });
  });

  it("claims neither managed nor external while custody wallets are unknown", () => {
    const data = buildOverviewHeroData(baseToken({ mintAuthority: MANAGED }), [], t, "en");

    expect(rowFor(data, "mint")?.identity).toEqual({ state: "unknown", publicKey: MANAGED });
  });

  it("reports an unset authority as none", () => {
    const data = buildOverviewHeroData(baseToken(), [wallet(MANAGED)], t, "en");

    expect(rowFor(data, "permanentDelegate")?.identity).toEqual({ state: "none" });
  });

  it("formats a compact supply / max, using ∞ when uncapped", () => {
    expect(
      buildOverviewHeroData(
        baseToken({ totalSupply: "1000000", maxSupply: "2000000000" }),
        [],
        t,
        "en"
      ).supply
    ).toBe("1M / 2B");
    expect(buildOverviewHeroData(baseToken({ totalSupply: "0" }), [], t, "en").supply).toBe(
      "0 / ∞"
    );
  });

  it("resolves the signing wallet to its custody wallet", () => {
    const signer = wallet(MANAGED);
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: signer.walletId }),
      [signer],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({
      state: "managed",
      name: "Treasury",
      provider: null,
      publicKey: MANAGED,
    });
  });

  // A signer is always a custody wallet (the API takes a walletId, resolved via
  // createOrgSigner), so the only non-managed states are "none pinned" and
  // "pinned but unresolvable".
  it("reports the project-default signer when no wallet is pinned", () => {
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: null }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({ state: "default" });
  });

  it("flags a pinned signer that no longer resolves to a custody wallet", () => {
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: "wlt_removed" }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({ state: "unresolved", walletId: "wlt_removed" });
  });

  it("stays neutral for a pinned signer while the custody wallets are unknown", () => {
    const data = buildOverviewHeroData(baseToken({ signingWalletId: "wlt_1" }), [], t, "en");

    expect(data.signerWallet).toBeNull();
  });

  it("derives issuer + category tiles from the asset profile", () => {
    const data = buildOverviewHeroData(baseToken({ assetProfile: stablecoinProfile }), [], t, "en");

    expect(data.issuer).toBe("Veritas Finance");
    expect(data.category).toEqual({
      label: t("DashboardIssuance.config.currency"),
      value: "USD",
    });
  });

  it("derives the website from the asset profile, or null without one", () => {
    expect(
      buildOverviewHeroData(baseToken({ assetProfile: stablecoinProfile }), [], t, "en").website
    ).toBe("https://veritas.finance");
    expect(buildOverviewHeroData(baseToken(), [], t, "en").website).toBeNull();
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
        signerWallets={[]}
        openIds={new Set()}
        onToggle={() => undefined}
        onCreate={() => undefined}
      />
    );
    expect(markup).toContain("vUSD");
    expect(markup).toContain("Veritas Finance");
    expect(markup).toContain(t("DashboardIssuance.workspace.manage"));
    // Collapsed row shows the taxonomy chip.
    expect(markup).toContain(t("DashboardIssuance.taxonomy.fiatBacked"));
  });
});
